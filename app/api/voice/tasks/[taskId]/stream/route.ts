import { asc, eq, inArray } from "drizzle-orm"

import { withUser } from "@/db"
import {
  callAttempts,
  callOutcomes,
  conversationTurns,
  voiceCalls,
  voiceTasks,
} from "@/db/schema"
import { authenticate } from "@/lib/auth"

// Live status of one voice task for its owner (API_AND_EXECUTION_CONTRACTS
// §4), modelled on /api/events: read through withUser, each change sent
// once, every second while a call is live and every 5 s otherwise; the
// browser reconnects after 10 minutes. Turns only when the owner opened the
// live transcript (?transcript=1). Never used for notifications (D-07).

const LIVE_MS = 1_000
const IDLE_MS = 5_000
const MAX_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Event = Record<string, unknown> & { type: string }

async function snapshot(userId: string, taskId: string, transcript: boolean) {
  return withUser(userId, async (tx) => {
    const [task] = await tx
      .select({ status: voiceTasks.status, result: voiceTasks.result })
      .from(voiceTasks)
      .where(eq(voiceTasks.id, taskId))
    if (!task) return null
    const calls = await tx
      .select({
        id: voiceCalls.id,
        kind: voiceCalls.kind,
        status: voiceCalls.status,
        attempts: voiceCalls.attempts,
        availableAt: voiceCalls.availableAt,
      })
      .from(voiceCalls)
      .where(eq(voiceCalls.voiceTaskId, taskId))
    // Granted columns only
    const attempts = calls.length
      ? await tx
          .select({
            id: callAttempts.id,
            status: callAttempts.status,
            updatedAt: callAttempts.updatedAt,
          })
          .from(callAttempts)
          .where(
            inArray(
              callAttempts.voiceCallId,
              calls.map((c) => c.id)
            )
          )
      : []
    const outcomes = await tx
      .select({ id: callOutcomes.id, verifierStatus: callOutcomes.verifierStatus })
      .from(callOutcomes)
      .where(eq(callOutcomes.voiceTaskId, taskId))
    const turns =
      transcript && attempts.length
        ? await tx
            .select({
              attemptId: conversationTurns.callAttemptId,
              seq: conversationTurns.seq,
              speaker: conversationTurns.speaker,
              text: conversationTurns.text,
            })
            .from(conversationTurns)
            .where(
              inArray(
                conversationTurns.callAttemptId,
                attempts.map((a) => a.id)
              )
            )
            .orderBy(asc(conversationTurns.seq))
        : []
    const events: Event[] = [
      { type: "task", status: task.status, result: task.result },
      ...calls.map((c) => ({
        type: "call",
        callId: c.id,
        kind: c.kind,
        status: c.status,
        attempts: c.attempts,
        nextAt: c.availableAt.toISOString(),
      })),
      ...attempts.map((a) => ({
        type: "attempt",
        attemptId: a.id,
        status: a.status,
        at: a.updatedAt.toISOString(),
      })),
      ...outcomes.map((o) => ({
        type: "outcome",
        id: o.id,
        verifierStatus: o.verifierStatus,
      })),
      ...turns.map((t) => ({
        type: "turn",
        id: `${t.attemptId}:${t.seq}`,
        seq: t.seq,
        speaker: t.speaker,
        text: t.text,
      })),
    ]
    return {
      events,
      live: calls.some((c) => c.status === "dialing" || c.status === "in_call"),
    }
  })
}

// Each thing has one identity; it's sent again only when it changed
const keyOf = (e: Event) =>
  `${e.type}:${String(e.callId ?? e.attemptId ?? e.id ?? "task")}`

export async function GET(
  request: Request,
  ctx: { params: Promise<{ taskId: string }> }
) {
  const user = await authenticate()
  if (!user) return new Response("Sign in to continue.", { status: 401 })
  const { taskId } = await ctx.params
  if (!UUID.test(taskId)) return new Response("Not found.", { status: 404 })
  const transcript = new URL(request.url).searchParams.get("transcript") === "1"
  const first = await snapshot(user.id, taskId, transcript)
  // Another person's task looks exactly like no task (API §1)
  if (!first) return new Response("Not found.", { status: 404 })

  const encoder = new TextEncoder()
  const sent = new Map<string, string>()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text))
      const opened = Date.now()
      send("retry: 3000\n\n")
      let current: Awaited<ReturnType<typeof snapshot>> = first
      while (current && !request.signal.aborted && Date.now() - opened < MAX_MS) {
        for (const event of current.events) {
          const body = JSON.stringify(event)
          if (sent.get(keyOf(event)) === body) continue
          sent.set(keyOf(event), body)
          send(`data: ${body}\n\n`)
        }
        send(": keep-alive\n\n")
        await new Promise((resolve) =>
          setTimeout(resolve, current!.live ? LIVE_MS : IDLE_MS)
        )
        try {
          current = await snapshot(user.id, taskId, transcript)
        } catch {
          break
        }
      }
      try {
        controller.close()
      } catch {}
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
