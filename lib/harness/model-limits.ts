import { eq } from "drizzle-orm"

import { privileged } from "@/db"
import { models } from "@/db/schema"
import { getSetting } from "@/lib/config"

// What a model can hold (harness upgrade U3, U9; KU-ADR-09): its context
// window and output cap from kriya.models (filled from the provider's
// catalogue by syncCatalogue), and the output cap the gateway really allows:
// the owner's harness.maxOutputTokens, never above the model's own. The
// client declares them for its tiers so DSH compacts before the window is
// full; unknown stays unknown (the client then keeps DSH's defaults).

export type ModelLimits = { contextWindow: number; maxOutputTokens: number }

export const OUTPUT_FLOOR = 1024
export const OUTPUT_CEILING = 262_144

/** The owner's per-answer output cap, kept within OUTPUT_FLOOR…OUTPUT_CEILING. */
export async function outputSetting() {
  const n = Number(await getSetting("harness.maxOutputTokens"))
  return Number.isSafeInteger(n)
    ? Math.min(Math.max(n, OUTPUT_FLOOR), OUTPUT_CEILING)
    : 65_536
}

async function row(modelId: string) {
  const [found] = await privileged
    .select({
      contextWindow: models.contextWindow,
      maxOutputTokens: models.maxOutputTokens,
    })
    .from(models)
    .where(eq(models.id, modelId))
  return found
}

/** The most output a request to this model may ask for. */
export async function outputCap(modelId: string) {
  const [setting, found] = await Promise.all([outputSetting(), row(modelId)])
  return Math.min(setting, found?.maxOutputTokens ?? setting)
}

export async function modelLimits(modelId: string): Promise<ModelLimits | null> {
  const [setting, found] = await Promise.all([outputSetting(), row(modelId)])
  if (!found?.contextWindow) return null
  return {
    contextWindow: found.contextWindow,
    maxOutputTokens: Math.min(setting, found.maxOutputTokens ?? setting),
  }
}
