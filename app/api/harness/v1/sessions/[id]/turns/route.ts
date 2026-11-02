import { z } from "zod"

import { TurnRequest } from "@/lib/harness/contract"
import { appendTurn } from "@/lib/harness/mirror"
import { fail, harnessRoute, readBody } from "@/lib/harness/route"

// One turn of a mirrored session (H6): 204, a seq already stored ignored;
// `full` only when the device mirrors everything
const idOf = (request: Request) =>
  z.uuid().safeParse(new URL(request.url).pathname.split("/").at(-2)).data

export const POST = harnessRoute(true, async (request, device) => {
  const id = idOf(request)
  if (!id) return fail(404, "not_found", "Not found.")
  const body = await readBody(request, TurnRequest)
  if (body instanceof Response) return body
  const result = await appendTurn(device, id, body)
  if (!result) return fail(404, "not_found", "Not found.")
  if (result === "summary_only")
    return fail(
      403,
      "mirror_summary_only",
      "This device mirrors summaries only; send the turn without tool details."
    )
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
