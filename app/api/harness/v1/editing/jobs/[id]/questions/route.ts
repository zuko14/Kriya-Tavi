import { z } from "zod"

import { getSetting } from "@/lib/config"
import { askQuestion } from "@/lib/editing/review"
import { EditingQuestionRequest } from "@/lib/harness/contract"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// Track E, ED15: a decision card from this computer's job. No device route answers one
// (track E rule 13): the person does, in the Inbox.
export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("editing.review")) !== "on")
    return fail(404, "not_found", "Not found.")
  const job = z.uuid().safeParse(new URL(request.url).pathname.split("/").at(-2)).data
  if (!job) return fail(404, "not_found", "Not found.")
  const body = await readBody(request, EditingQuestionRequest)
  if (body instanceof Response) return body
  if (body.defaultOption >= body.options.length)
    return fail(400, "bad_request", "The default must be one of the choices.")
  const made = await askQuestion(device, job, body)
  return made ? ok(made) : fail(404, "not_found", "Not found.")
})
