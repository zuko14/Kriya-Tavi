import { z } from "zod"

import { getSetting } from "@/lib/config"
import { DispatchReportRequest } from "@/lib/harness/contract"
import { report } from "@/lib/harness/control"
import { fail, harnessRoute, readBody } from "@/lib/harness/route"

// Control Center: how this computer's action went; 404 when it isn't this
// computer's or has finished
const idOf = (request: Request) =>
  z.uuid().safeParse(new URL(request.url).pathname.split("/").at(-1)).data

export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("harness.controlCenter")) !== "on")
    return fail(404, "not_found", "Not found.")
  const id = idOf(request)
  if (!id) return fail(404, "not_found", "Not found.")
  const body = await readBody(request, DispatchReportRequest)
  if (body instanceof Response) return body
  if (!(await report(device, id, body))) return fail(404, "not_found", "Not found.")
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
