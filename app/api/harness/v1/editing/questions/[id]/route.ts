import { z } from "zod"

import { getSetting } from "@/lib/config"
import { waitForEditAnswer } from "@/lib/editing/review"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// Track E, ED15: a decision card's answer, as a long poll (?wait=0…25), for the device
// that asked. No method here answers it.
const WAIT = z.coerce.number().int().min(0).max(25).default(0)

export const GET = harnessRoute(true, async (request, device) => {
  if ((await getSetting("editing.review")) !== "on")
    return fail(404, "not_found", "Not found.")
  const url = new URL(request.url)
  const id = z.uuid().safeParse(url.pathname.split("/").at(-1)).data
  if (!id) return fail(404, "not_found", "Not found.")
  const wait = WAIT.safeParse(url.searchParams.get("wait") ?? undefined)
  if (!wait.success) return fail(400, "bad_request", "wait is 0 to 25 seconds.")
  const answer = await waitForEditAnswer(device, id, wait.data, request.signal)
  return answer ? ok(answer) : fail(404, "not_found", "Not found.")
})
