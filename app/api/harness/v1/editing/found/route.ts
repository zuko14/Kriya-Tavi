import { getSetting } from "@/lib/config"
import { foundRecording } from "@/lib/editing/review"
import { EditingFoundRequest } from "@/lib/harness/contract"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// Track E, ED15, EDD-47: a new recording in a folder this computer watches. Only its name
// and duration come here, and nothing runs until the person taps (ES-21).
export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("editing.watchFolders")) !== "on")
    return fail(404, "not_found", "Not found.")
  const body = await readBody(request, EditingFoundRequest)
  if (body instanceof Response) return body
  const found = await foundRecording(device, body)
  if (found === "no_project")
    return fail(409, "no_project", "That folder isn't one this computer offers.")
  if (found === "full")
    return fail(429, "rate_limited", "Too many new recordings are waiting for an answer.")
  return ok(found)
})
