import { z } from "zod"

import { getSetting } from "@/lib/config"
import { notesForJob } from "@/lib/editing/review"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// Track E, ED15: the notes the person sent in this revision. Read-only for a device.
export const GET = harnessRoute(true, async (request, device) => {
  if ((await getSetting("editing.review")) !== "on")
    return fail(404, "not_found", "Not found.")
  const job = z.uuid().safeParse(new URL(request.url).pathname.split("/").at(-2)).data
  const notes = job ? await notesForJob(device, job) : null
  return notes ? ok({ notes }) : fail(404, "not_found", "Not found.")
})
