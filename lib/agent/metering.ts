import type { LanguageModelUsage } from "ai"
import { and, eq, inArray } from "drizzle-orm"

import { privileged } from "@/db"
import { charges, plans, usageEvents, type Task } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { modelPrices, usageFromMetadata } from "@/lib/models"
import { estimateMicroUsd, priceTask } from "@/lib/money"

// Every model request becomes one usage_events row, keyed by
// <task>:<attempt>:<call> so a retried insert or a duplicate delivery can
// never count it twice. The provider's reported cost is kept apart from our
// estimate, and missing usage is recorded as missing, never as zero.

export type ModelCall = {
  task: Pick<Task, "id" | "userId" | "tier">
  attempt: number
  call: number
  model: string
  usage?: LanguageModelUsage
  providerMetadata?: unknown
  generationId?: string
  finishReason?: string
  latencyMs?: number
  error?: string
}

export async function recordUsage(call: ModelCall) {
  const reported = usageFromMetadata(call.providerMetadata)
  const input = call.usage?.inputTokens ?? null
  const output = call.usage?.outputTokens ?? null
  const hasUsage = input != null || output != null
  const estimate =
    reported?.costMicroUsd == null
      ? estimateMicroUsd({ input, output }, await modelPrices(call.model))
      : null

  const row = {
    requestKey: `${call.task.id}:${call.attempt}:${call.call}`,
    userId: call.task.userId,
    taskId: call.task.id,
    attempt: call.attempt,
    step: call.call,
    provider: "openrouter",
    model: call.model,
    tier: call.task.tier,
    generationId: call.generationId ?? null,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: call.usage?.outputTokenDetails?.reasoningTokens ?? null,
    cachedTokens: call.usage?.inputTokenDetails?.cacheReadTokens ?? null,
    usageStatus: hasUsage ? ("reported" as const) : ("missing" as const),
    costMicroUsd: reported?.costMicroUsd ?? null,
    costSource:
      reported?.costMicroUsd != null
        ? ("provider" as const)
        : estimate != null
          ? ("estimate" as const)
          : null,
    estimatedCostMicroUsd: estimate,
    latencyMs: call.latencyMs ?? null,
    finishReason: call.finishReason ?? null,
    error: call.error ?? null,
    // Normalized provider usage, for reconciliation (no prompt content)
    raw: reported?.raw ?? null,
  }
  await privileged.insert(usageEvents).values(row).onConflictDoNothing({
    target: usageEvents.requestKey,
  })
  return row.costMicroUsd ?? row.estimatedCostMicroUsd ?? 0
}

async function computeCharge(task: Pick<Task, "id" | "planId">) {
  const rows = await privileged
    .select({
      costMicroUsd: usageEvents.costMicroUsd,
      estimatedCostMicroUsd: usageEvents.estimatedCostMicroUsd,
    })
    .from(usageEvents)
    .where(eq(usageEvents.taskId, task.id))
  const [plan] = await privileged
    .select({ markupBps: plans.markupBps })
    .from(plans)
    .where(eq(plans.id, task.planId))
  return priceTask(
    rows,
    { rate: await getSetting("fx.usdInr"), source: await getSetting("fx.source") },
    plan?.markupBps ?? 10000
  )
}

// After reconciliation filled in provider costs: an estimated or unpriced
// charge is recomputed. A final charge is never changed.
export async function repriceTask(task: Pick<Task, "id" | "planId">) {
  const charge = await computeCharge(task)
  await privileged
    .update(charges)
    .set(charge)
    .where(
      and(eq(charges.taskId, task.id), inArray(charges.status, ["estimated", "unpriced"]))
    )
  return charge
}

// One charge per task, across all its attempts. Written once when the task
// ends; a second call (a retried finish) changes nothing.
export async function chargeTask(task: Pick<Task, "id" | "userId" | "planId">) {
  const charge = await computeCharge(task)
  await privileged
    .insert(charges)
    .values({ userId: task.userId, taskId: task.id, planId: task.planId, ...charge })
    .onConflictDoNothing({ target: charges.taskId })
  return charge
}
