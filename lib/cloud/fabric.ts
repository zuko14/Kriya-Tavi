import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm"

import { privileged } from "@/db"
import { execLeases, execNodes } from "@/db/schema"
import {
  DEFAULT_POLICY,
  parseNodes,
  type FabricNode,
  type FabricPolicy,
  type SelfHostedWorkspaceProvider,
} from "@/lib/cloud/providers/selfhosted"
import { getSetting } from "@/lib/config"
import { log } from "@/lib/log"
import { NODE_PROTOCOL } from "@/cloud-node/protocol"

// The self-hosted fabric's control-plane side (CD-29, CD-32, CD-35): the
// selfhosted.* settings, and one sweep per janitor round that measures each
// node, keeps kriya.exec_nodes current and reconciles leases with what the
// nodes actually run. The node agents never touch the database (CD-28).

export type FabricSettings = {
  nodes: FabricNode[]
  drain: string[]
  policy: FabricPolicy
}

export async function fabricSettings(): Promise<FabricSettings> {
  const int = async (key: Parameters<typeof getSetting>[0], fallback: number) =>
    Number.parseInt((await getSetting(key)) ?? "", 10) || fallback
  const users = (await getSetting("selfhosted.users")) ?? ""
  const maxWaitSeconds = await int("selfhosted.maxWaitSeconds", 60)
  return {
    nodes: parseNodes(await getSetting("selfhosted.nodes")),
    drain: ((await getSetting("selfhosted.drain")) ?? "").split(",").filter(Boolean),
    policy: {
      ...DEFAULT_POLICY,
      admission: (await getSetting("selfhosted.holdAdmissions")) === "on" ? "off" : "on",
      isolation:
        (await getSetting("selfhosted.isolation")) === "trusted-runc"
          ? "trusted-runc"
          : "gvisor",
      users: users === "*" ? "*" : users.split(",").filter(Boolean),
      maxWaitSeconds,
      maxPerUser: await int("selfhosted.maxPerUser", 1),
      maxQueued: await int("selfhosted.maxQueued", 50),
      cpuOvercommitPct: await int("selfhosted.cpuOvercommitPct", 150),
      diskMb: (await int("selfhosted.diskGb", 10)) * 1024,
      idleSeconds: (await int("selfhosted.idleMinutes", 15)) * 60,
      // A waiter gives up at maxWaitSeconds, so starving must start before
      // that or the starvation stop never fires
      starvationSeconds: Math.min(
        await int("selfhosted.starvationSeconds", 120),
        Math.max(5, Math.floor(maxWaitSeconds / 2))
      ),
    },
  }
}

// A lease granted this long ago that never started: its worker died
const START_TIMEOUT_SECONDS = 180

const ago = (seconds: number) => sql`now() - make_interval(secs => ${seconds})`

export async function fabricSweep(
  provider: SelfHostedWorkspaceProvider,
  drain: string[]
) {
  const result = { measured: 0, unhealthy: 0, released: 0 }
  const ids = provider.nodes.map((n) => n.id)

  // (1) The node list follows the settings
  for (const id of ids) {
    const status = drain.includes(id) ? "draining" : "active"
    await privileged
      .insert(execNodes)
      .values({ id, status })
      .onConflictDoUpdate({ target: execNodes.id, set: { status } })
  }
  await privileged
    .update(execNodes)
    .set({ status: "retired", healthy: false, reason: "removed from selfhosted.nodes" })
    .where(ids.length ? notInArray(execNodes.id, ids) : sql`true`)

  // (2) Measurements; a node that doesn't answer, isn't ready or speaks
  // another protocol takes nothing until it does
  const reachable = new Set<string>()
  for (const id of ids) {
    try {
      const stats = await provider.stats(id)
      const ok =
        !!stats &&
        stats.protocol === NODE_PROTOCOL &&
        stats.nodeId === id &&
        stats.ready &&
        stats.isolation !== null
      if (stats) reachable.add(id)
      await privileged
        .update(execNodes)
        .set({
          healthy: ok,
          reason: ok
            ? null
            : !stats
              ? "the node didn't answer"
              : stats.nodeId !== id
                ? "the node reports another id"
                : stats.protocol !== NODE_PROTOCOL
                  ? `protocol ${String(stats.protocol).slice(0, 40)}`
                  : stats.reasons.join("; ").slice(0, 300) || "not ready",
          ...(stats && {
            isolation: stats.isolation,
            cpuMillis: stats.cpuMillis,
            memMb: stats.memMb,
            diskMb: stats.diskMb,
            diskFreeMb: stats.diskFreeMb,
            inodesFree: stats.inodesFree,
            memAvailableMb: stats.memAvailableMb,
            psiCpu: stats.psi.cpu === null ? null : String(stats.psi.cpu),
            psiMem: stats.psi.memory === null ? null : String(stats.psi.memory),
            psiIo: stats.psi.io === null ? null : String(stats.psi.io),
            containers: stats.containers,
            agentVersion: stats.agentVersion.slice(0, 64),
            imageDigest: stats.imageDigest,
          }),
          statsAt: new Date(),
        })
        .where(eq(execNodes.id, id))
      result.measured++
      if (!ok) result.unhealthy++
    } catch (error) {
      result.unhealthy++
      await privileged
        .update(execNodes)
        .set({ healthy: false, reason: "the node didn't answer", statsAt: new Date() })
        .where(eq(execNodes.id, id))
      log.warn("workspace node not measured", { node: id, error: String(error) })
    }
  }

  // (3) Leases against reality: starts that never happened, nodes that left,
  // sandboxes a reachable node no longer has. Each release is idempotent
  const release = async (where: ReturnType<typeof and>, reason: string) => {
    const gone = await privileged
      .update(execLeases)
      .set({ status: "released", endedAt: new Date(), reason })
      .where(where)
      .returning({ id: execLeases.id })
    result.released += gone.length
  }
  await release(
    and(
      eq(execLeases.status, "granted"),
      lt(execLeases.grantedAt, ago(START_TIMEOUT_SECONDS))
    ),
    "start_timeout"
  )
  await release(
    and(
      inArray(execLeases.status, ["granted", "running", "stopped"]),
      ids.length ? notInArray(execLeases.nodeId, ids) : sql`true`
    ),
    "node_retired"
  )
  for (const id of reachable) {
    const sandboxes = await provider.listNode(id)
    if (!sandboxes) continue
    const listed = new Set(sandboxes.map((s) => s.ref))
    const stoppedThere = new Set(sandboxes.filter((s) => !s.running).map((s) => s.ref))
    const live = await privileged
      .select({ id: execLeases.id, ref: execLeases.ref, status: execLeases.status })
      .from(execLeases)
      .where(
        and(
          eq(execLeases.nodeId, id),
          inArray(execLeases.status, ["running", "stopped"]),
          // A start in flight may not be listed yet
          lt(execLeases.startedAt, ago(60))
        )
      )
    const missing = live.filter((l) => l.ref && !listed.has(l.ref)).map((l) => l.id)
    if (missing.length) await release(inArray(execLeases.id, missing), "gone")
    // Stopped by the node itself (idle, disk quota): its CPU and memory go
    // back to the pool; the disk stays reserved
    const idle = live
      .filter((l) => l.status === "running" && l.ref && stoppedThere.has(l.ref))
      .map((l) => l.id)
    if (idle.length) {
      const moved = await privileged
        .update(execLeases)
        .set({ status: "stopped", reason: "node_stopped" })
        .where(and(inArray(execLeases.id, idle), eq(execLeases.status, "running")))
        .returning({ id: execLeases.id })
      result.released += moved.length
    }
  }
  return result
}
