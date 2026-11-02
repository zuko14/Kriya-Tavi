import { SessionCreateRequest } from "@/lib/harness/contract"
import { openSession } from "@/lib/harness/mirror"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// A device session opens its mirror thread (H6): 201 the first time, 200
// for one already open; 404 while the platform's or the device's mirror is off
export const POST = harnessRoute(true, async (request, device) => {
  const body = await readBody(request, SessionCreateRequest)
  if (body instanceof Response) return body
  const opened = await openSession(device, body)
  if (!opened) return fail(404, "not_found", "Not found.")
  if (opened === "no_agent")
    return fail(
      409,
      "no_agent",
      "Choose the agent this device works as in Kriya, Account → Devices."
    )
  const { created, ...session } = opened
  return ok(session, created ? 201 : 200)
})
