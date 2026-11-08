import { z } from "zod"

import { getSetting } from "@/lib/config"
import { markUploaded } from "@/lib/editing/previews"
import { fail, harnessRoute } from "@/lib/harness/route"

// Track E, EDD-46: the upload finished. The worker checks the object from here;
// nobody can watch it until then. 404 when it isn't this computer's.
export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("editing.previews")) !== "on")
    return fail(404, "not_found", "Not found.")
  const parts = new URL(request.url).pathname.split("/")
  const job = z.uuid().safeParse(parts.at(-3)).data
  const id = z.uuid().safeParse(parts.at(-1)).data
  if (!job || !id || !(await markUploaded(device, job, id)))
    return fail(404, "not_found", "Not found.")
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
