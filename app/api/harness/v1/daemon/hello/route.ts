import { getSetting } from "@/lib/config"
import { DaemonHelloRequest } from "@/lib/harness/contract"
import { hello } from "@/lib/harness/control"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// Control Center: the daemon says what it allows (set on the computer), its
// project folders and its rules; 404 while harness.controlCenter is off
export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("harness.controlCenter")) !== "on")
    return fail(404, "not_found", "Not found.")
  const body = await readBody(request, DaemonHelloRequest)
  if (body instanceof Response) return body
  return ok(await hello(device, body))
})
