import { and, eq, inArray, sql } from "drizzle-orm"
import type { z } from "zod"

import { privileged, withUser } from "@/db"
import {
  harnessCartridgeOutcomes,
  harnessCartridgeVersions,
  harnessDevices,
  harnessSessions,
  messages,
  threads,
} from "@/db/schema"
import type { DeviceUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { previewText } from "@/lib/events"
import type { SessionCreateRequest, TurnRequest } from "@/lib/harness/contract"
import { mirrorLabel } from "@/lib/harness/mirror-context"
import { log } from "@/lib/log"
import { guardCanaries } from "@/lib/harness/scout/versions"

// The session mirror (H6, HD-09): a device session becomes one thread of
// the device's agent, titled "<device> · <project>", and each turn one
// assistant message: the label (MIRROR_CONTEXT, so the cloud agent treats
// it as untrusted), the turn's text, a compact tool line, and only in
// `full` mode each tool's details. Threads and messages are written as the
// person (withUser); harness_sessions has no insert policy, so its rows are
// privileged, scoped by the device's person and the device.

type Mode = "summary" | "full"

// The device's mirror mode, or null while either switch is off
async function modeOf(device: DeviceUser): Promise<Mode | null> {
  if ((await getSetting("harness.mirror")) !== "on") return null
  const [row] = await privileged
    .select({ mirror: harnessDevices.mirror })
    .from(harnessDevices)
    .where(
      and(eq(harnessDevices.id, device.deviceId), eq(harnessDevices.userId, device.id))
    )
  return row && row.mirror !== "off" ? row.mirror : null
}

const deviceName = async (device: DeviceUser) =>
  (
    await privileged
      .select({ name: harnessDevices.name })
      .from(harnessDevices)
      .where(eq(harnessDevices.id, device.deviceId))
  )[0]?.name ?? "Kriya Harness"

const sessionOf = (device: DeviceUser, where: ReturnType<typeof eq>) =>
  privileged
    .select({ id: harnessSessions.id, threadId: harnessSessions.threadId })
    .from(harnessSessions)
    .where(
      and(
        where,
        eq(harnessSessions.userId, device.id),
        eq(harnessSessions.deviceId, device.deviceId)
      )
    )

export async function openSession(
  device: DeviceUser,
  body: z.infer<typeof SessionCreateRequest>
) {
  const mirror = await modeOf(device)
  if (!mirror) return null
  if (!device.agentId) return "no_agent" as const
  const [found] = await sessionOf(
    device,
    eq(harnessSessions.deviceSessionId, body.deviceSessionId)
  )
  if (found)
    return { sessionId: found.id, threadId: found.threadId, mirror, created: false }

  const title = `${await deviceName(device)} · ${body.project || "session"}`
  const [thread] = await withUser(device.id, (tx) =>
    tx
      .insert(threads)
      .values({
        userId: device.id,
        agentId: device.agentId,
        title,
        preview: body.title || null,
      })
      .returning({ id: threads.id })
  )
  const [made] = await privileged
    .insert(harnessSessions)
    .values({
      userId: device.id,
      deviceId: device.deviceId,
      threadId: thread.id,
      deviceSessionId: body.deviceSessionId,
      project: body.project || null,
    })
    .onConflictDoNothing()
    .returning({ id: harnessSessions.id })
  if (made) return { sessionId: made.id, threadId: thread.id, mirror, created: true }
  // Opened twice at once: the other request's thread stands, this one goes
  await withUser(device.id, (tx) => tx.delete(threads).where(eq(threads.id, thread.id)))
  const [winner] = await sessionOf(
    device,
    eq(harnessSessions.deviceSessionId, body.deviceSessionId)
  )
  return { sessionId: winner.id, threadId: winner.threadId, mirror, created: false }
}

type Turn = z.infer<typeof TurnRequest>

// "bash ✓ 1.2 s · edit ✓ · bash declined"
export function toolLine(tools: Turn["tools"]) {
  return tools
    .map(({ name, status, ms }) =>
      status === "ok"
        ? `${name} ✓${ms >= 1000 ? ` ${(ms / 1000).toFixed(1)} s` : ""}`
        : status === "error"
          ? `${name} ✗`
          : `${name} declined`
    )
    .join(" · ")
}

// A fence longer than any run of backticks inside, so device text can't close it
function fenced(content: string, lang = "") {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = "`".repeat(longest + 1)
  return `${fence}${lang}\n${content}\n${fence}`
}

function details(full: NonNullable<Turn["full"]>) {
  const tools = Array.isArray(full.tools) ? full.tools : [full]
  return tools
    .map((tool) => {
      const { name, input, output } = (tool ?? {}) as Record<string, unknown>
      const parts = [`**${typeof name === "string" ? name.slice(0, 60) : "tool"}**`]
      if (input !== undefined) parts.push(fenced(JSON.stringify(input, null, 2), "json"))
      if (output !== undefined)
        parts.push(
          fenced(typeof output === "string" ? output : JSON.stringify(output, null, 2))
        )
      return parts.join("\n\n")
    })
    .join("\n\n")
}

export function turnText(mode: Mode, turn: Turn) {
  const line = toolLine(turn.tools)
  return [
    mirrorLabel(mode),
    turn.text.trim(),
    line && `\`${line}\``,
    mode === "full" && turn.full ? details(turn.full) : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

// The calendar day in India, for outcome rows
const istDay = (now: Date) =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)

/**
 * Harness 2.0 W11 (WD-15): a turn's cartridge outcome counts, by stored
 * version, added to today's row of this person and device. Counts for a
 * version Kriya never stored are dropped. Only when harness.workforce is on.
 */
async function outcomeRows(device: DeviceUser, outcomes: Turn["cartridgeOutcomes"]) {
  if (!outcomes?.length || (await getSetting("harness.workforce")) !== "on") return []
  const versions = await privileged
    .select({
      id: harnessCartridgeVersions.id,
      cartridgeId: harnessCartridgeVersions.cartridgeId,
      version: harnessCartridgeVersions.version,
    })
    .from(harnessCartridgeVersions)
    .where(
      inArray(
        harnessCartridgeVersions.cartridgeId,
        outcomes.map((o) => o.cartridgeId)
      )
    )
  const day = istDay(new Date())
  return outcomes.flatMap((o) => {
    const v = versions.find(
      (x) => x.cartridgeId === o.cartridgeId && x.version === o.version
    )
    return v
      ? [
          {
            userId: device.id,
            deviceId: device.deviceId,
            versionId: v.id,
            day,
            verified: o.verified,
            blocked: o.blocked,
            notChecked: o.notChecked,
            undone: o.undone,
            cartridgeId: v.cartridgeId,
          },
        ]
      : []
  })
}

export async function appendTurn(device: DeviceUser, sessionId: string, turn: Turn) {
  const mirror = await modeOf(device)
  if (!mirror) return null
  if (turn.full && mirror !== "full") return "summary_only" as const
  const [found] = await sessionOf(device, eq(harnessSessions.id, sessionId))
  if (!found) return null
  const text = turnText(mirror, turn)
  const counts = await outcomeRows(device, turn.cartridgeOutcomes)
  // The message id is the seq: a turn sent twice is stored once
  const inserted = await withUser(device.id, async (tx) => {
    const rows = await tx
      .insert(messages)
      .values({
        threadId: found.threadId,
        id: `mirror-${sessionId}-${turn.seq}`,
        userId: device.id,
        role: "assistant",
        parts: [{ type: "text", text }],
        metadata: {
          agentId: device.agentId,
          harness: {
            deviceId: device.deviceId,
            sessionId,
            seq: turn.seq,
            tools: turn.tools,
          },
        },
      })
      .onConflictDoNothing()
      .returning({ id: messages.id })
    if (rows.length)
      await tx
        .update(threads)
        .set({ preview: previewText(turn.text) || null, activeAt: new Date() })
        .where(eq(threads.id, found.threadId))
    // Counted once: only with the turn's first delivery (a resent seq adds nothing)
    if (rows.length)
      for (const { cartridgeId, ...row } of counts) {
        void cartridgeId
        await tx
          .insert(harnessCartridgeOutcomes)
          .values(row)
          .onConflictDoUpdate({
            target: [
              harnessCartridgeOutcomes.userId,
              harnessCartridgeOutcomes.deviceId,
              harnessCartridgeOutcomes.versionId,
              harnessCartridgeOutcomes.day,
            ],
            set: {
              verified: sql`${harnessCartridgeOutcomes.verified} + ${row.verified}`,
              blocked: sql`${harnessCartridgeOutcomes.blocked} + ${row.blocked}`,
              notChecked: sql`${harnessCartridgeOutcomes.notChecked} + ${row.notChecked}`,
              undone: sql`${harnessCartridgeOutcomes.undone} + ${row.undone}`,
            },
          })
      }
    return rows.length > 0
  })
  // The guard (SELF_EVOLUTION §6) on the canaries these counts touched; its failure never loses the turn
  if (inserted && counts.length)
    await guardCanaries([...new Set(counts.map((c) => c.cartridgeId))]).catch((error) =>
      log.error("cartridge guard failed", { error: (error as Error)?.name ?? "error" })
    )
  if (inserted)
    await privileged
      .update(harnessSessions)
      .set({ lastSeq: sql`greatest(${harnessSessions.lastSeq}, ${turn.seq})` })
      .where(eq(harnessSessions.id, sessionId))
  return "ok" as const
}
