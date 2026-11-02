import { DeviceTokenRequest } from "@/lib/harness/contract"
import { issueToken, POLL_SECONDS } from "@/lib/harness/devices"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// The client's poll: 428 until the person answers, then the device token once
export const POST = harnessRoute(false, async (request) => {
  const input = await readBody(request, DeviceTokenRequest)
  if (input instanceof Response) return input
  const issued = await issueToken(input.deviceCode)
  switch (issued.status) {
    case "issued":
      return ok({ token: issued.token, deviceId: issued.deviceId })
    case "pending":
      return fail(428, "pending", "Waiting for you to approve this device in Kriya.")
    case "denied":
      return fail(403, "denied", "This sign-in was denied in Kriya.")
    case "slow_down":
      return fail(429, "rate_limited", "Polling too fast.", { retryAfter: POLL_SECONDS })
    case "expired":
      return fail(410, "expired", "This sign-in expired. Run kriya login again.")
  }
})
