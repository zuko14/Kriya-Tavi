import { getSetting } from "@/lib/config"
import { RunReportRequest } from "@/lib/harness/contract"
import { recordRun } from "@/lib/harness/control"
import { fail, harnessRoute, readBody } from "@/lib/harness/route"

// Control Center: what a kriya process on this computer runs (mode,
// switches, project name, state; no task text from the terminal)
export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("harness.controlCenter")) !== "on")
    return fail(404, "not_found", "Not found.")
  const body = await readBody(request, RunReportRequest)
  if (body instanceof Response) return body
  await recordRun(device, body)
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
