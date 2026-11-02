import { revokeSelf } from "@/lib/harness/devices"
import { harnessRoute } from "@/lib/harness/route"

// The calling device signs itself out (kriya logout)
export const DELETE = harnessRoute(true, async (_request, device) => {
  await revokeSelf(device)
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
