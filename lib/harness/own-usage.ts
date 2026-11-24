import "server-only"

import { and, desc, gte, sql } from "drizzle-orm"
import type { z } from "zod"

import { privileged, withUser } from "@/db"
import { harnessOwnUsage } from "@/db/schema"
import type { OwnUsageRequest } from "@/lib/harness/contract"

// Own models (docs/kriya-harness/OWN_MODELS.md): counts from the person's own
// API keys. The device route writes after authenticateDevice, scoped by the
// device's person and device (invariant 1: privileged with its own check);
// the person reads through withUser (RLS); the owner reads totals only.

type Device = { id: string; deviceId: string }

export async function recordOwnUsage(
  device: Device,
  body: z.infer<typeof OwnUsageRequest>
) {
  await privileged.insert(harnessOwnUsage).values(
    body.entries.map((e) => ({
      userId: device.id,
      deviceId: device.deviceId,
      provider: e.provider,
      model: e.model,
      requests: e.requests,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      reportedCostMicroUsd: e.reportedCostMicroUsd ?? null,
    }))
  )
}

const monthStart = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

const totals = {
  provider: harnessOwnUsage.provider,
  model: harnessOwnUsage.model,
  requests: sql<number>`sum(${harnessOwnUsage.requests})::int`,
  inputTokens: sql<number>`sum(${harnessOwnUsage.inputTokens})::bigint`.mapWith(Number),
  outputTokens: sql<number>`sum(${harnessOwnUsage.outputTokens})::bigint`.mapWith(Number),
  // Null unless the provider reported every row's cost: a partial sum isn't shown as a total
  reportedCostMicroUsd: sql<
    number | null
  >`case when bool_and(${harnessOwnUsage.reportedCostMicroUsd} is not null) then sum(${harnessOwnUsage.reportedCostMicroUsd}) end`.mapWith(
    (v) => (v === null ? null : Number(v))
  ),
}

/** This month's own-key usage for the person, per provider and model */
export async function ownUsageThisMonth(userId: string) {
  return withUser(userId, (tx) =>
    tx
      .select(totals)
      .from(harnessOwnUsage)
      .where(gte(harnessOwnUsage.at, monthStart()))
      .groupBy(harnessOwnUsage.provider, harnessOwnUsage.model)
      .orderBy(
        desc(sql`sum(${harnessOwnUsage.inputTokens} + ${harnessOwnUsage.outputTokens})`)
      )
      .limit(50)
  )
}

/** The owner's view: this month's totals across everyone, per provider and model (no person named) */
export async function ownUsageTotals() {
  return privileged
    .select({
      ...totals,
      people: sql<number>`count(distinct ${harnessOwnUsage.userId})::int`,
    })
    .from(harnessOwnUsage)
    .where(and(gte(harnessOwnUsage.at, monthStart())))
    .groupBy(harnessOwnUsage.provider, harnessOwnUsage.model)
    .orderBy(
      desc(sql`sum(${harnessOwnUsage.inputTokens} + ${harnessOwnUsage.outputTokens})`)
    )
    .limit(100)
}
