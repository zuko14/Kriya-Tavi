import { getSetting } from "@/lib/config"
import { searchMedia } from "@/lib/editing/media"
import { EditingMediaRequest } from "@/lib/harness/contract"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// Track E, EDD-52: openly licensed pictures for the Director's plan. Metadata only; the
// computer downloads what the person approves. 404 while editing.mediaSearch is off.
export const POST = harnessRoute(true, async (request) => {
  if ((await getSetting("editing.mediaSearch")) !== "on")
    return fail(404, "not_found", "Not found.")
  const body = await readBody(request, EditingMediaRequest)
  if (body instanceof Response) return body
  return ok(await searchMedia(body.queries, request.signal))
})
