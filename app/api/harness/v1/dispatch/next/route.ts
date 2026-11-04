import { z } from "zod"

import { getSetting } from "@/lib/config"
import { next } from "@/lib/harness/control"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// Control Center: the daemon's long poll (?wait=0…25): the next action for
// this computer, claimed by this answer, and the ones to stop
const WAIT = z.coerce.number().int().min(0).max(25).default(0)

export const GET = harnessRoute(true, async (request, device) => {
  if ((await getSetting("harness.controlCenter")) !== "on")
    return fail(404, "not_found", "Not found.")
  const wait = WAIT.safeParse(new URL(request.url).searchParams.get("wait") ?? undefined)
  if (!wait.success) return fail(400, "bad_request", "wait is 0 to 25 seconds.")
  return ok(await next(device, wait.data, request.signal))
})
