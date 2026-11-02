import { getSetting } from "@/lib/config"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// H10, HD-12: where `kriya serve` connects, and who it is. kriya-relay calls
// this with the device's own token to check a connection (the relay has no
// database), so revoking a device here also drops it there.
export const GET = harnessRoute(true, async (_request, device) => {
  const relayUrl = process.env.KRIYA_RELAY_URL?.replace(/\/+$/, "")
  if ((await getSetting("harness.deviceWorld")) !== "on" || !relayUrl)
    return fail(404, "not_found", "Not found.")
  return ok({ deviceId: device.deviceId, relayUrl })
})
