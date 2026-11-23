import { eq } from "drizzle-orm"

import { privileged } from "@/db"
import { models, TIERS, type Tier } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"
import { modelLimits } from "@/lib/harness/model-limits"
import { BODY_ENCODINGS, harnessRoute, ok } from "@/lib/harness/route"
import { modelForTier } from "@/lib/models"
import { isTier } from "@/lib/tiers"

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
      .select({ label: models.label, images: models.supportsImages })
      .from(models)
      .where(eq(models.id, id))
    return {
      name: displayName(row?.label, id),
      limits: await modelLimits(id),
      images: row?.images === true,
    }
  } catch {
    // Not routed yet: the level is listed without a name or limits
    return { name: undefined, limits: null, images: false }
  }
}

/**
 * Harness 2.0 W2 (upgrade_2.0/ORCHESTRA.md §1): the owner's head and worker
 * levels, only with harness.workforce on, the two different and both in the
 * plan; otherwise nothing, and the client runs on one level as before.
 */
export async function orchestraFor(allowed: readonly Tier[]) {
  if ((await getSetting("harness.workforce")) !== "on") return undefined
  const [head, worker] = await Promise.all([
    getSetting("harness.orchestraHead"),
    getSetting("harness.orchestraWorker"),
  ])
  if (!isTier(head) || !isTier(worker) || head === worker) return undefined
  if (!allowed.includes(head) || !allowed.includes(worker)) return undefined
  return { head, worker }
}

export const GET = harnessRoute(true, async (_request, device) => {
  const plan = await getPlan(device.id)
  const allowed = TIERS.filter((tier) => plan.allowedTiers.includes(tier))
  const [found, orchestra] = await Promise.all([
    Promise.all(allowed.map(levelInfo)),
    orchestraFor(allowed),
  ])
  return ok({
    object: "list",
    data: allowed.map((id, i) => ({
      id,
      object: "model",
      owned_by: "kriya",
      ...(found[i].name && { name: found[i].name }),
      ...found[i].limits,
      ...(found[i].images && { images: true as const }),
    })),
    bodyEncodings: [...BODY_ENCODINGS],
    ...(orchestra && { orchestra }),
    ...((await getSetting("harness.workforce")) === "on" && { workforce: 1 as const }),
  })
})
