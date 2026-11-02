import { appUrl } from "@/lib/auth"
import { DeviceCodeRequest } from "@/lib/harness/contract"
import { createDeviceCode } from "@/lib/harness/devices"
import { addressOf, fail, harnessRoute, ok, readBody } from "@/lib/harness/route"
import { allow } from "@/lib/rate-limit"

// Starts a device sign-in (HD-05): a device code for the client to poll with
// and a short code the person confirms at /connect/device. 10 an hour per
// address.
export const POST = harnessRoute(false, async (request) => {
  if (!(await allow(`harness:code:${addressOf(request)}`, 10, 3600)))
    return fail(429, "rate_limited", "Too many sign-in attempts; try again later.", {
      retryAfter: 3600,
    })
  const input = await readBody(request, DeviceCodeRequest)
  if (input instanceof Response) return input
  const started = await createDeviceCode(input)
  return ok({ ...started, verificationUrl: `${appUrl()}/connect/device` })
})
