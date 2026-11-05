import fs from "node:fs"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { nodeKey } from "@/cloud-node/protocol"
import { createNodeServer } from "@/cloud-node/server"
import { RunnerRequestError } from "@/lib/cloud/client"
import { fabricSweep } from "@/lib/cloud/fabric"
import { janitorSettings, workspaceJanitor } from "@/lib/cloud/janitor"
import {
  DEFAULT_POLICY,
  SelfHostedWorkspaceProvider,
  type FabricPolicy,
} from "@/lib/cloud/providers/selfhosted"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"

import type { TestDb } from "../db/harness"
import { cloudDb } from "./db"
import { fixtureSource, memoryStore, textOf } from "./fake-provider"
import { InProcessRuntime } from "./node-runtime"

// The self-hosted provider end to end (CD-28…CD-35; TEST_STRATEGY
// CT-SH-E2E-*, CT-SH-REC-*): TaskWorkspace → SelfHostedWorkspaceProvider →
// exec_request/exec_admit on Postgres (PGlite) → the real node agent → its
// proxy → the real runner. Failures are injected at each hop.

const hasGit = spawnSync("git", ["--version"]).status === 0
const SECRET = "n".repeat(43)

const SETTINGS: CloudSettings = {
  image: "kriya-runner:test",
  size: "2c-4g",
  network: "registries",
  commandTimeoutSeconds: 60,
  maxRunning: 10,
  maxImportMb: 50,
  maxCheckpointMb: 10,
  costMicroUsdPerHour: null,
}

let db: Awaited<ReturnType<typeof cloudDb>>
let pg: TestDb
let runtime: InProcessRuntime
let node: ReturnType<typeof createNodeServer>
let base: string
let store: ReturnType<typeof memoryStore>["store"]

async function startNode() {
  node = createNodeServer({
    nodeId: "n1",
    key: nodeKey(SECRET, "n1"),
    runtime,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-node-state-")),
    dataDir: os.tmpdir(),
    reserve: { cpuMillis: 0, memMb: 0, diskMb: 0 },
    defaults: { idleSeconds: 900, diskMb: 10_240 },
  })
  await node.reprobe()
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`
}

async function stopNode() {
  node.server.closeAllConnections()
  await new Promise<void>((r) => node.server.close(() => r()))
}

const provider = (
  policy: Partial<FabricPolicy> = {},
  nodes = [{ id: "n1", url: base }]
) =>
  new SelfHostedWorkspaceProvider({
    nodes,
    secret: SECRET,
    policy: {
      ...DEFAULT_POLICY,
      // The in-process runtime isolates nothing and reports runc
      isolation: "trusted-runc",
      users: "*",
      maxWaitSeconds: 2,
      // Sweeps measure the real machine: a busy CI runner isn't a busy node
      psiCpuMax: 100,
      psiMemMax: 100,
      psiIoMax: 100,
      ...policy,
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 100))),
  })

const workspace = (
  p: SelfHostedWorkspaceProvider,
  task: { id: string; userId: string; threadId: string; agentId: string }
) =>
  new TaskWorkspace(p, task, SETTINGS, {
    source: fixtureSource().source,
    store,
    healthMs: 5000,
  })

// Only so much room on the node (sweeps measure the real machine)
const capacity = (memMb: number) =>
  pg.query(
    "update kriya.exec_nodes set mem_mb = $1, cpu_millis = 16000 where id = 'n1'",
    [memMb]
  )

const leases = async () =>
  (
    await pg.query<{
      id: string
      status: string
      reason: string | null
      ref: string | null
    }>("select id, status, reason, ref from kriya.exec_leases order by id")
  ).rows.map((r) => ({ ...r, id: Number(r.id) }))

const workspaceRow = async (threadId: string) =>
  (
    await pg.query<{
      status: string
      provider_ref: string | null
      generation: number
      error: string | null
    }>(
      "select status, provider_ref, generation, error from kriya.workspaces where thread_id = $1 order by created_at desc limit 1",
      [threadId]
    )
  ).rows[0]

beforeAll(async () => {
  db = await cloudDb()
  pg = db.pg
})

beforeEach(async () => {
  runtime = new InProcessRuntime()
  store = memoryStore().store
  await startNode()
  await pg.query("delete from kriya.exec_leases")
  await pg.query("delete from kriya.workspace_sessions")
  await pg.query("delete from kriya.workspaces")
  await pg.query("delete from kriya.exec_nodes")
  await fabricSweep(provider(), [])
})

afterEach(async () => {
  await stopNode().catch(() => {})
  await runtime.closeAll()
})

describe.skipIf(!hasGit)("CT-SH-E2E: a workspace on a self-hosted node", () => {
  it("E2E-01: open, run, checkpoint, pause; the next task resumes the same sandbox under a newer fence", async () => {
    const t1 = await db.task("e1")
    const ws1 = workspace(provider(), t1)
    const opened = await ws1.open({ repo: "acme/web" })
    expect(opened.status).toBe("running")
    const c1 = await ws1.client()
    const end = await c1.exec({
      command: "echo kept > note.txt && cat note.txt",
      timeoutSeconds: 10,
    })
    expect(end.exitCode).toBe(0)
    const [first] = await leases()
    expect(first).toMatchObject({ status: "running" })
    expect(node.fences.get(first.ref!)).toBe(first.id)
    await ws1.close(null)
    expect((await leases())[0].status).toBe("stopped")
    expect((await runtime.inspect(first.ref!))?.running).toBe(false)
    expect(await workspaceRow(t1.threadId)).toMatchObject({
      status: "paused",
      generation: 1,
    })

    const t2 = await db.task("e1")
    const ws2 = workspace(provider(), t2)
    const c2 = await ws2.client()
    expect(await textOf(c2, "note.txt")).toBe("kept\n")
    const after = await leases()
    expect(after.map((l) => l.status)).toEqual(["released", "running"])
    expect(after[0].reason).toBe("replaced")
    expect(after[1].id).toBeGreaterThan(after[0].id)
    expect(node.fences.get(first.ref!)).toBe(after[1].id)
    expect(runtime.calls.filter((c) => c.startsWith("create"))).toHaveLength(1)
    await ws2.close(null)
  })

  it("E2E-02: someone off the allow-list gets no sandbox and no lease", async () => {
    const t = await db.task("e2")
    const ws = workspace(provider({ users: [] }), t)
    await expect(ws.open({ repo: "acme/web" })).rejects.toThrow(/couldn't be started/)
    expect(await leases()).toEqual([])
    expect((await workspaceRow(t.threadId)).error).toMatch(
      /aren't available for this account/
    )
  })

  it("E2E-03: a full node queues the next start; it runs when room frees up, or says busy", async () => {
    await capacity(4096)
    const bob = await (await import("../db/harness")).createUser(pg)
    const ta = await db.task("e3a")
    const tb = await db.task("e3b", bob)
    const wa = workspace(provider(), ta)
    await wa.open({ repo: "acme/web" })
    // Bob waits, then is told it's busy; nothing is left queued
    const wb = workspace(provider(), tb)
    await expect(wb.open({ repo: "acme/web" })).rejects.toThrow(/couldn't be started/)
    expect((await workspaceRow(tb.threadId)).error).toMatch(/busy/)
    expect((await leases()).find((l) => l.status === "cancelled")?.reason).toBe(
      "wait_timeout"
    )
    // Bob again, with a longer wait: Alice finishes meanwhile, Bob gets the slot
    const tb2 = await db.task("e3b", bob)
    const wb2 = workspace(provider({ maxWaitSeconds: 15 }), tb2)
    const pending = wb2.open({ repo: "acme/web" })
    await new Promise((r) => setTimeout(r, 800))
    await wa.close(null)
    expect((await pending).status).toBe("running")
    const live = (await leases()).filter((l) => l.status === "running")
    expect(live).toHaveLength(1)
    await wb2.close(null)
  })

  it("REC-01: a worker that died is fenced: the janitor takes the sandbox over, the old client is refused", async () => {
    const t1 = await db.task("r1")
    const stale = provider()
    const ws1 = workspace(stale, t1)
    await ws1.open({ repo: "acme/web" })
    const old = await ws1.client()
    await old.exec({ command: "echo before > a.txt", timeoutSeconds: 10 })
    // The worker stops heartbeating (crash or partition), never closes
    await pg.query(
      "update kriya.workspace_sessions set heartbeat_at = now() - interval '10 minutes'"
    )
    const swept = await workspaceJanitor({
      provider: provider(),
      store,
      settings: { ...(await janitorSettings()), enabled: true, cloud: SETTINGS },
      reconcile: false,
      drain: [],
      healthMs: 5000,
    })
    expect(swept?.orphans).toBe(1)
    expect(await workspaceRow(t1.threadId)).toMatchObject({ status: "paused" })
    // The old holder can do nothing more
    await expect(
      old.exec({ command: "echo after > b.txt", timeoutSeconds: 10 })
    ).rejects.toMatchObject({
      status: 409,
    })
    // The next task resumes with every file the old one wrote
    const t2 = await db.task("r1")
    const ws2 = workspace(provider(), t2)
    const c2 = await ws2.client()
    expect(await textOf(c2, "a.txt")).toBe("before\n")
    await expect(textOf(c2, "b.txt")).rejects.toBeInstanceOf(RunnerRequestError)
    // The dead worker's late pause can't stop the new holder's sandbox
    const ref = (await workspaceRow(t2.threadId)).provider_ref!
    await stale.pause(ref)
    expect((await runtime.inspect(ref))?.running).toBe(true)
    await ws2.close(null)
  })

  it("REC-02: an unreachable node is not 'gone' (stays paused); a node that lost the sandbox restores from the checkpoint", async () => {
    const t1 = await db.task("r2")
    const ws1 = workspace(provider(), t1)
    await ws1.open({ repo: "acme/web" })
    await (await ws1.client()).exec({ command: "echo saved > s.txt", timeoutSeconds: 10 })
    await ws1.close(null)
    const ref = (await workspaceRow(t1.threadId)).provider_ref!

    await stopNode()
    const t2 = await db.task("r2")
    await expect(workspace(provider(), t2).client()).rejects.toThrow(
      /couldn't be started/
    )
    expect(await workspaceRow(t1.threadId)).toMatchObject({
      status: "paused",
      provider_ref: ref,
    })
    expect((await leases()).at(-1)).toMatchObject({
      status: "released",
      reason: "start_failed",
    })

    // Back, but its disk is gone
    await startNode()
    await runtime.remove(ref)
    await fabricSweep(provider(), [])
    const t3 = await db.task("r2")
    const ws3 = workspace(provider(), t3)
    const c3 = await ws3.client()
    expect(await textOf(c3, "s.txt")).toBe("saved\n")
    expect(await workspaceRow(t3.threadId)).toMatchObject({
      status: "running",
      generation: 2,
    })
    await ws3.close(null)
  })

  it("REC-03: the sweep marks a dead node unhealthy and releases leases that can't be real", async () => {
    const t = await db.task("r3")
    const ws = workspace(provider(), t)
    await ws.open({ repo: "acme/web" })
    const ref = (await workspaceRow(t.threadId)).provider_ref!
    // A sandbox the node no longer runs, a start that never happened
    await runtime.remove(ref)
    await pg.query(
      "update kriya.exec_leases set started_at = now() - interval '5 minutes'"
    )
    const ws2 = await pg.query<{ id: string }>(
      "insert into kriya.workspaces (user_id, provider, image, size, status) values ($1, 'selfhosted', 'i', '2c-4g', 'paused') returning id",
      [t.userId]
    )
    await pg.query(
      `insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status, granted_at)
       values ($1, $2, 1, 'n1', $3, 1000, 1024, 0, 'granted', now() - interval '10 minutes')`,
      [t.userId, ws2.rows[0].id, `sh-n1-${ws2.rows[0].id}-1`]
    )
    const swept = await fabricSweep(provider(), [])
    expect(swept.released).toBe(2)
    expect((await leases()).map((l) => l.reason).sort()).toEqual([
      "gone",
      "start_timeout",
    ])

    // A sandbox the node stopped on its own gives back its CPU and memory
    const t2 = await db.task("r3b")
    await workspace(provider(), t2).open({ repo: "acme/web" })
    const ref2 = (await workspaceRow(t2.threadId)).provider_ref!
    await runtime.stop(ref2)
    await pg.query(
      "update kriya.exec_leases set started_at = now() - interval '5 minutes' where ref = $1",
      [ref2]
    )
    await fabricSweep(provider(), [])
    expect((await leases()).find((l) => l.ref === ref2)).toMatchObject({
      status: "stopped",
      reason: "node_stopped",
    })

    await stopNode()
    expect((await fabricSweep(provider(), [])).unhealthy).toBe(1)
    const sick = await pg.query(
      "select healthy, reason from kriya.exec_nodes where id = 'n1'"
    )
    expect(sick.rows[0]).toEqual({ healthy: false, reason: "the node didn't answer" })
    // Removed from the settings: retired
    await fabricSweep(provider({}, []), [])
    expect((await pg.query("select status from kriya.exec_nodes")).rows[0]).toEqual({
      status: "retired",
    })
  })

  it("REC-04: draining checkpoints and removes paused sandboxes and takes no new ones", async () => {
    const t = await db.task("r4")
    const ws = workspace(provider(), t)
    await ws.open({ repo: "acme/web" })
    await (await ws.client()).exec({ command: "echo moved > m.txt", timeoutSeconds: 10 })
    await ws.close(null)
    const ref = (await workspaceRow(t.threadId)).provider_ref!
    // A change after the last checkpoint that only the stopped disk holds
    const swept = await workspaceJanitor({
      provider: provider(),
      store,
      settings: { ...(await janitorSettings()), enabled: true, cloud: SETTINGS },
      reconcile: false,
      drain: ["n1"],
      healthMs: 5000,
    })
    expect(swept?.destroyed).toBe(1)
    expect(await runtime.inspect(ref)).toBeNull()
    expect((await workspaceRow(t.threadId)).provider_ref).toBeNull()
    // A new workspace finds no node
    const other = await db.task("r4b")
    await expect(workspace(provider(), other).open({ repo: "acme/web" })).rejects.toThrow(
      /couldn't be started/
    )
    // Undrained: restored from the checkpoint on a fresh sandbox
    await fabricSweep(provider(), [])
    const t2 = await db.task("r4")
    const c2 = await workspace(provider(), t2).client()
    expect(await textOf(c2, "m.txt")).toBe("moved\n")
  })

  it("SEC: no lease, node row or node answer holds the runner token", async () => {
    const t = await db.task("s1")
    const ws = workspace(provider(), t)
    await ws.open({ repo: "acme/web" })
    const ref = (await workspaceRow(t.threadId)).provider_ref!
    const token = runtime.envOf(ref)!.KRIYA_RUNNER_TOKEN
    const rows = JSON.stringify([
      (await pg.query("select * from kriya.exec_leases")).rows,
      (await pg.query("select * from kriya.exec_nodes")).rows,
      await provider().list(),
      await provider().stats("n1"),
    ])
    expect(rows).not.toContain(token)
    await ws.close(null)
  })
})
