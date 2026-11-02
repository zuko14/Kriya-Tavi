import { deviceAccount } from "@/lib/harness/devices"
import { harnessRoute, ok } from "@/lib/harness/route"

// Who this device is: the person's name and plan, the harness cap and this
// month's use, the agent it works as
export const GET = harnessRoute(true, async (_request, device) =>
  ok(await deviceAccount(device))
)
