import { getSetting } from "@/lib/config"
import { LiveReportRequest } from "@/lib/harness/contract"
import { recordLive } from "@/lib/harness/live"
import { fail, harnessRoute, readBody } from "@/lib/harness/route"

// Remote Control: what a session the person switched on is doing right now
export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("harness.remoteControl")) !== "on")
    return fail(404, "not_found", "Not found.")
  const body = await readBody(request, LiveReportRequest)
  if (body instanceof Response) return body
  await recordLive(device, body)
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
