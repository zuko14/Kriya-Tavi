import { TIERS } from "@/db/schema"
import { getPlan } from "@/lib/entitlements"
import { harnessRoute, ok } from "@/lib/harness/route"

// The model levels this person's plan allows, as OpenAI lists models
export const GET = harnessRoute(true, async (_request, device) => {
  const plan = await getPlan(device.id)
  return ok({
    object: "list",
    data: TIERS.filter((tier) => plan.allowedTiers.includes(tier)).map((id) => ({
      id,
      object: "model",
      owned_by: "kriya",
    })),
  })
})
