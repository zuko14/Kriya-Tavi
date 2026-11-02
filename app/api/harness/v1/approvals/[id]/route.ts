import { z } from "zod"

import { cancelApproval, waitForAnswer } from "@/lib/harness/approvals"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// One approval request, for the device that made it: its status (a
// long-poll with ?wait=0…25) and DELETE when the person answered in the
// terminal. No method here answers it (HS-4)

const idOf = (request: Request) =>
  z.uuid().safeParse(new URL(request.url).pathname.split("/").at(-1)).data

const WAIT = z.coerce.number().int().min(0).max(25).default(0)

const missing = () => fail(404, "not_found", "Not found.")

export const GET = harnessRoute(true, async (request, device) => {
  const id = idOf(request)
  if (!id) return missing()
  const wait = WAIT.safeParse(new URL(request.url).searchParams.get("wait") ?? undefined)
  if (!wait.success) return fail(400, "bad_request", "wait is 0 to 25 seconds.")
  const status = await waitForAnswer(device, id, wait.data, request.signal)
  if (status === "busy") {
    return fail(429, "rate_limited", "Too many requests; slow down.", { retryAfter: 5 })
  }
  return status ? ok({ status }) : missing()
})

export const DELETE = harnessRoute(true, async (request, device) => {
  const id = idOf(request)
  if (!id || !(await cancelApproval(device, id))) return missing()
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
