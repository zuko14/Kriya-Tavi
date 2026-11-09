import { getSetting } from "@/lib/config"
import { defineTerms } from "@/lib/editing/media"
import { EditingDefineRequest } from "@/lib/harness/contract"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// Track E, EDD-57: a hard term's definition, quoted with its citation. 404 while
// editing.mediaSearch is off.
export const POST = harnessRoute(true, async (request) => {
  if ((await getSetting("editing.mediaSearch")) !== "on")
    return fail(404, "not_found", "Not found.")
  const body = await readBody(request, EditingDefineRequest)
  if (body instanceof Response) return body
  return ok(await defineTerms(body.terms, request.signal))
})
