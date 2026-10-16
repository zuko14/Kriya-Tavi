import { and, eq, gt } from "drizzle-orm"

import { withUser } from "@/db"
import { agents, tasks, threads } from "@/db/schema"
import { authenticate } from "@/lib/auth"
import { previewText, type KriyaEvent } from "@/lib/events"

// A server-sent event stream of the person's tasks starting and finishing,
// for notifications. Tasks run in the worker, so this follows the tasks
// table (through RLS) rather than an in-process event bus.

const POLL_MS = 3_000
const MAX_MS = 10 * 60_000

export async function GET(request: Request) {
  const user = await authenticate()
  if (!user) return new Response("Sign in to continue.", { status: 401 })

  const encoder = new TextEncoder()
  // A little behind now, so clock skew between server and database can't hide a change
  let since = new Date(Date.now() - 10_000)
  // Status last sent per task, so each change is announced once
  const announced = new Map<string, string>()

  const poll = async () => {
    const rows = await withUser(user.id, (tx) =>
      tx
        .select({
          id: tasks.id,
          status: tasks.status,
          error: tasks.error,
          threadId: tasks.threadId,
          updatedAt: tasks.updatedAt,
          startedAt: tasks.startedAt,
          finishedAt: tasks.finishedAt,
          squadId: threads.squadId,
          preview: threads.preview,
          agentId: agents.id,
          name: agents.name,
          glyph: agents.glyph,
        })
        .from(tasks)
        .innerJoin(threads, eq(threads.id, tasks.threadId))
        .leftJoin(agents, eq(agents.id, tasks.agentId))
        .where(and(eq(tasks.userId, user.id), gt(tasks.updatedAt, since)))
        .orderBy(tasks.updatedAt)
        .limit(50)
    )
    const events: KriyaEvent[] = []
    for (const row of rows) {
      if (row.updatedAt > since) since = row.updatedAt
      const kind =
        row.status === "queued" || row.status === "running" ? "started" : "finished"
      if (announced.get(row.id) === kind) continue
      announced.set(row.id, kind)
      const common = {
        threadId: row.threadId,
        href: row.squadId
          ? `/s/${row.squadId}/${row.threadId}`
          : `/a/${row.agentId}/${row.threadId}`,
        name: row.name ?? "Your agent",
        glyph: row.glyph ?? "",
      }
      if (kind === "started") events.push({ ...common, type: "turn-started" })
      // A task the person stopped needs no news
      else if (row.status !== "canceled") {
        events.push({
          ...common,
          type: "turn-finished",
          preview: previewText(row.preview ?? ""),
          ok: row.status === "succeeded",
          ...(row.error && { error: row.error }),
          durationMs:
            row.finishedAt && row.startedAt
              ? row.finishedAt.getTime() - row.startedAt.getTime()
              : 0,
        })
      }
    }
    return events
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text))
      const opened = Date.now()
      send("retry: 3000\n\n")
      // The browser reconnects after MAX_MS, keeping connections short-lived
      while (!request.signal.aborted && Date.now() - opened < MAX_MS) {
        try {
          for (const event of await poll()) send(`data: ${JSON.stringify(event)}\n\n`)
          send(": keep-alive\n\n")
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
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
