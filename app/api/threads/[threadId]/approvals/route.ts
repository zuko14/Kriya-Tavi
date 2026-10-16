import { z } from "zod"

import { enqueueApproval, TurnError } from "@/lib/agent/queue"
import { authenticate } from "@/lib/auth"
import { log } from "@/lib/log"
import { allow } from "@/lib/rate-limit"

const bodySchema = z.object({
  approvalId: z.string().min(1).max(128),
  approved: z.boolean(),
})

const threadId = z.string().min(1).max(32)

function fail(message: string, status = 400, code = "bad_request") {
  return Response.json({ error: message, code }, { status })
}

// Approve or decline a tool call an agent is waiting on. The page then
// follows the continuation through GET /api/threads/[threadId]/turn.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ threadId: string }> }
) {
  const user = await authenticate()
  if (!user) return fail("Sign in to continue.", 401, "unauthenticated")
  const id = threadId.safeParse((await ctx.params).threadId)
  if (!id.success) return fail("Thread not found.", 404, "not_found")
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("Malformed request.")

  if (!(await allow(`approval:${user.id}`, 30, 60))) {
    return fail("Too many requests. Wait a moment.", 429, "rate_limited")
  }

  try {
    const task = await enqueueApproval({
      userId: user.id,
      threadId: id.data,
      ...parsed.data,
    })
    return Response.json({ queued: !!task })
  } catch (error) {
    if (error instanceof TurnError) return fail(error.message, error.status, error.code)
    log.error("could not record approval", { threadId: id.data, error })
    return fail("Couldn't record your answer. Try again.", 500, "internal")
  }
}
