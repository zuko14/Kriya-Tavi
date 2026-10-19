import { createUIMessageStreamResponse } from "ai"
import { z } from "zod"

import {
  activeTask,
  cancelThreadTask,
  enqueueTurn,
  streamTask,
  TurnError,
} from "@/lib/agent/queue"
import type { KriyaMessage } from "@/lib/agent/tools"
import { authenticate } from "@/lib/auth"
import { LITE_HEADER } from "@/lib/lite"
import { log } from "@/lib/log"
import { allow } from "@/lib/rate-limit"

const MAX_TEXT = 20_000

const bodySchema = z.object({
  message: z.object({
    id: z.string().min(1).max(64),
    role: z.literal("user"),
    // Text only; anything else is the server's to add
    parts: z
      .array(
        z.object({ type: z.literal("text"), text: z.string().max(MAX_TEXT) }).loose()
      )
      .min(1)
      .max(16),
    metadata: z
      .object({ agentId: z.string().max(32).optional() })
      .loose()
      .optional(),
  }),
  agentId: z.string().max(32).optional(),
})

const threadId = z.string().min(1).max(32)

function fail(message: string, status = 400, code = "bad_request") {
  return Response.json({ error: message, code }, { status })
}

// Lite mode (K10): the browser asks for a slower stream on slow networks
const lite = (request: Request) => ({
  lite:
    request.headers.get(LITE_HEADER) === "1" ||
    new URL(request.url).searchParams.get("lite") === "1",
})

// Queue a turn and stream it as it runs in the worker
export async function POST(
  request: Request,
  ctx: { params: Promise<{ threadId: string }> }
) {
  const user = await authenticate()
  if (!user) return fail("Sign in to continue.", 401, "unauthenticated")
  const id = threadId.safeParse((await ctx.params).threadId)
  if (!id.success) return fail("Thread not found.", 404, "not_found")

  if (Number(request.headers.get("content-length") ?? 0) > 200_000) {
    return fail("Message is too long.", 413, "too_large")
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("Malformed message.")
  const text = parsed.data.message.parts.map((part) => part.text).join("")
  if (!text.trim()) return fail("Message is empty.")
  if (text.length > MAX_TEXT) return fail("Message is too long.", 413, "too_large")

  // A burst guard on top of the plan's daily limit
  if (!(await allow(`turn:${user.id}`, 30, 60))) {
    return fail(
      "You're sending messages too quickly. Wait a moment.",
      429,
      "rate_limited"
    )
  }

  try {
    const task = await enqueueTurn({
      userId: user.id,
      threadId: id.data,
      message: parsed.data.message as unknown as KriyaMessage,
      agentId: parsed.data.agentId,
      idempotencyKey: `msg:${id.data}:${parsed.data.message.id}`,
    })
    return createUIMessageStreamResponse({
      stream: streamTask(user.id, task.id, request.signal, lite(request)),
    })
  } catch (error) {
    if (error instanceof TurnError) return fail(error.message, error.status, error.code)
    log.error("could not queue turn", { threadId: id.data, error })
    return fail("Couldn't start the task. Try again.", 500, "internal")
  }
}

// Re-attach to a task that is still running (page refresh, reopened tab)
export async function GET(
  request: Request,
  ctx: { params: Promise<{ threadId: string }> }
) {
  const user = await authenticate()
  if (!user) return fail("Sign in to continue.", 401, "unauthenticated")
  const id = threadId.safeParse((await ctx.params).threadId)
  if (!id.success) return new Response(null, { status: 204 })
  const task = await activeTask(user.id, id.data)
  if (!task) return new Response(null, { status: 204 })
  return createUIMessageStreamResponse({
    stream: streamTask(user.id, task.id, request.signal, lite(request)),
  })
}

// Stop the running task. What was produced so far is kept.
export async function DELETE(_: Request, ctx: { params: Promise<{ threadId: string }> }) {
  const user = await authenticate()
  if (!user) return fail("Sign in to continue.", 401, "unauthenticated")
  const id = threadId.safeParse((await ctx.params).threadId)
  if (!id.success) return Response.json({ stopped: false })
  return Response.json({ stopped: await cancelThreadTask(user.id, id.data) })
}
