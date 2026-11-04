import { eq } from "drizzle-orm"

import { privileged } from "@/db"
import { models, TIERS, type Tier } from "@/db/schema"
import { getPlan } from "@/lib/entitlements"
import { modelLimits } from "@/lib/harness/model-limits"
import { BODY_ENCODINGS, harnessRoute, ok } from "@/lib/harness/route"
import { modelForTier } from "@/lib/models"

// The model levels this person's plan allows, as OpenAI lists models, each
// with the name of the model the owner routes it to (/owner/config
// routing.*): the harness shows that name, not the level
const NAME = /^[\p{L}\p{N} .()+/:_-]{1,60}$/u

/** "DeepSeek: DeepSeek V4.1 Flash" → "DeepSeek V4.1 Flash"; undefined if unusable */
export function displayName(label: string | null | undefined, id: string) {
  const raw = (label || id.split("/").pop() || "").trim()
  const vendor = /^([^:]{1,40}):\s+(.+)$/.exec(raw)
  const name = (vendor && vendor[2].startsWith(vendor[1]) ? vendor[2] : raw)
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim()
  return NAME.test(name) ? name : undefined
}

async function levelInfo(tier: Tier) {
  try {
    const id = await modelForTier(tier)
    const [row] = await privileged
      .select({ label: models.label })
      .from(models)
      .where(eq(models.id, id))
    return { name: displayName(row?.label, id), limits: await modelLimits(id) }
  } catch {
    // Not routed yet: the level is listed without a name or limits
    return { name: undefined, limits: null }
  }
}

export const GET = harnessRoute(true, async (_request, device) => {
  const plan = await getPlan(device.id)
  const allowed = TIERS.filter((tier) => plan.allowedTiers.includes(tier))
  const found = await Promise.all(allowed.map(levelInfo))
  return ok({
    object: "list",
    data: allowed.map((id, i) => ({
      id,
      object: "model",
      owned_by: "kriya",
      ...(found[i].name && { name: found[i].name }),
      ...found[i].limits,
    })),
    bodyEncodings: [...BODY_ENCODINGS],
  })
})
