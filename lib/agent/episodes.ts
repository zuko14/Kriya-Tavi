import { createHash } from "node:crypto"

import { and, asc, desc, eq, sql } from "drizzle-orm"

import { privileged } from "@/db"
import {
  episodes,
  goals,
  toolExecutions,
  type EpisodeAction,
  type EpisodeClaim,
} from "@/db/schema"
import { actionTitle } from "@/lib/agent/approvals"
import { textOf } from "@/lib/agent/messages"
import { classifyTool } from "@/lib/agent/policy"
import type { KriyaMessage } from "@/lib/agent/tools"
import {
  checkCitations,
  sourceTexts,
  unconfirmedClaims,
  verificationOf,
} from "@/lib/agent/verify"

// "What I did" (AD-02) and the Kriya Receipt (K1, AD-27). An episode is
// derived by code from a task's tool runs: an action is listed as done only
// when it succeeded and its own check verified it. Everything else it ran,
// and anything the reply claims without a run, is "not confirmed". Each
// person's episodes form a hash chain, so a changed record shows.

type Run = {
  id: string
  toolName: string
  status: string
  input: unknown
  verification: unknown
}

export function deriveEpisode(runs: Run[], reply: string, sources: string[]) {
  const done: EpisodeAction[] = []
  const unconfirmed: EpisodeClaim[] = []
  for (const run of runs) {
    if (run.status !== "succeeded") continue
    const risk = classifyTool(run.toolName, run.input)
    const verification = verificationOf({ verification: run.verification })
    // Reads and notes aren't accomplishments; consequential runs, and any
    // run that checked itself, are
    if (!verification && !["R2", "R3", "R4"].includes(risk)) continue
    const title = actionTitle(run.toolName, run.input as Record<string, unknown>, "done")
    if (verification?.status === "verified") {
      done.push({ executionId: run.id, tool: run.toolName, title, risk, verification })
    } else {
      unconfirmed.push({
        claim: title,
        reason:
          verification?.status === "failed"
            ? "Ran, but the check afterwards failed."
            : "Ran, but wasn't checked afterwards.",
        executionId: run.id,
      })
    }
  }
  unconfirmed.push(
    ...unconfirmedClaims(
      reply,
      runs.map((run) => ({ tool: run.toolName, status: run.status }))
    )
  )
  return {
    done,
    unconfirmed,
    checks: checkCitations(reply, sources),
    titles: done.map((d) => d.title).join("\n") || null,
  }
}

// JSON with sorted keys, so the same record always hashes the same
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

// sha256(prev ‖ record). Only what code observed is hashed: which runs, of
// which tools, at which class, with which check. Titles and claims come
// from model-written text and are left out (AT-RCP-03).
export function receiptHash(
  prevHash: string | null,
  record: { seq: number; taskId: string; createdAt: string; done: EpisodeAction[] }
) {
  const body = canonical({
    seq: record.seq,
    taskId: record.taskId,
    createdAt: record.createdAt,
    done: record.done.map(({ executionId, tool, risk, verification }) => ({
      executionId,
      tool,
      risk,
      verification,
    })),
  })
  return createHash("sha256")
    .update(`${prevHash ?? ""}\n${body}`)
    .digest("hex")
}

// At the end of a task (agents.inbox on). Nothing is written for a task
// that did and claimed nothing. The advisory lock keeps two tasks of one
// person finishing together from forking the chain (AT-RCP-01).
export async function writeEpisode(task: {
  userId: string
  taskId: string
  threadId: string
  agentId: string | null
  reply: KriyaMessage | null
}) {
  const runs = await privileged
    .select({
      id: toolExecutions.id,
      toolName: toolExecutions.toolName,
      status: toolExecutions.status,
      input: toolExecutions.input,
      verification: toolExecutions.verification,
    })
    .from(toolExecutions)
    .where(eq(toolExecutions.taskId, task.taskId))
    .orderBy(asc(toolExecutions.startedAt))
  const reply = task.reply ? textOf(task.reply) : ""
  const sources = task.reply
    ? sourceTexts(task.reply.parts as { type: string; output?: unknown }[])
    : []
  const episode = deriveEpisode(runs, reply, sources)
  if (!episode.done.length && !episode.unconfirmed.length && !episode.checks.length) {
    return null
  }

  return privileged.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${task.userId}::text))`)
    const [last] = await tx
      .select({ seq: episodes.seq, hash: episodes.hash })
      .from(episodes)
      .where(eq(episodes.userId, task.userId))
      .orderBy(desc(episodes.seq))
      .limit(1)
    const [goal] = await tx
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.threadId, task.threadId), eq(goals.userId, task.userId)))
    const seq = (last?.seq ?? 0) + 1
    const createdAt = new Date()
    const [row] = await tx
      .insert(episodes)
      .values({
        userId: task.userId,
        taskId: task.taskId,
        threadId: task.threadId,
        agentId: task.agentId,
        goalId: goal?.id ?? null,
        ...episode,
        seq,
        prevHash: last?.hash ?? null,
        hash: receiptHash(last?.hash ?? null, {
          seq,
          taskId: task.taskId,
          createdAt: createdAt.toISOString(),
          done: episode.done,
        }),
        createdAt,
      })
      .onConflictDoNothing({ target: episodes.taskId })
      .returning()
    return row ?? null
  })
}

// "Verify my records": recomputes the chain. Records the person deleted
// (content cleared) and records gone with a deleted thread show as gaps,
// not tampering; the first record whose hash doesn't match is reported.
export async function verifyChain(userId: string) {
  const rows = await privileged
    .select()
    .from(episodes)
    .where(eq(episodes.userId, userId))
    .orderBy(asc(episodes.seq))
  const deleted: { seq: number; at: Date | null }[] = []
  let prev: string | null = null
  let expected = 1
  for (const row of rows) {
    const gap = row.seq !== expected
    for (; expected < row.seq; expected++) deleted.push({ seq: expected, at: null })
    expected = row.seq + 1
    // After a gap the link can't be checked; the record itself still can
    const base = gap ? row.prevHash : prev
    if (row.deletedAt) {
      deleted.push({ seq: row.seq, at: row.deletedAt })
    } else if (
      (!gap && row.prevHash !== prev) ||
      receiptHash(base, {
        seq: row.seq,
        taskId: row.taskId!,
        createdAt: row.createdAt.toISOString(),
        done: row.done,
      }) !== row.hash
    ) {
      return { ok: false as const, records: rows.length, deleted, firstMismatch: row.seq }
    }
    prev = row.hash
  }
  return { ok: true as const, records: rows.length, deleted }
}
