"use server"

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { privileged } from "@/db"
import { models, plans, profiles, tasks, TIERS, usageEvents } from "@/db/schema"
import { repriceTask } from "@/lib/agent/metering"
import { isUniqueViolation } from "@/lib/agent/queue"
import { requireOwner } from "@/lib/auth"
import { getSecret, isSettingKey, setSetting } from "@/lib/config"
import { log } from "@/lib/log"
import { creditsToMicroUsd } from "@/lib/money"
import { syncCatalogue } from "@/lib/models"
import { audit } from "@/lib/owner"

// Every owner action re-checks the role on the server and leaves an audit
// record. None of them can read a person's conversations.

export type OwnerState = { error?: string; message?: string } | null

const uuid = z.string().uuid()

function field(form: FormData, name: string) {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}

function fail(error: unknown): OwnerState {
  return { error: error instanceof Error ? error.message : String(error) }
}

/* ───────────────────────────── users ────────────────────────────── */

export async function setUserStatus(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  const userId = uuid.safeParse(field(form, "userId"))
  const status = z.enum(["active", "suspended"]).safeParse(field(form, "status"))
  const reason = field(form, "reason").trim().slice(0, 500)
  if (!userId.success || !status.success) return { error: "Invalid request." }
  if (userId.data === owner.id) return { error: "You can't suspend your own account." }
  if (status.data === "suspended" && !reason)
    return { error: "Give a reason for the record." }

  await privileged
    .update(profiles)
    .set({
      status: status.data,
      suspendedReason: status.data === "suspended" ? reason : null,
    })
    .where(eq(profiles.id, userId.data))
  if (status.data === "suspended") {
    // Stop whatever they have running
    await privileged
      .update(tasks)
      .set({ cancelRequestedAt: new Date() })
      .where(
        and(eq(tasks.userId, userId.data), inArray(tasks.status, ["queued", "running"]))
      )
  }
  await audit(
    owner.id,
    `user.${status.data === "suspended" ? "suspend" : "reactivate"}`,
    {
      type: "user",
      id: userId.data,
    },
    reason ? { reason } : undefined
  )
  revalidatePath(`/owner/users/${userId.data}`)
  return {
    message: status.data === "suspended" ? "Account suspended." : "Account reactivated.",
  }
}

/* ───────────────────────────── settings ─────────────────────────── */

export async function saveSetting(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  const key = field(form, "key")
  if (!isSettingKey(key)) return { error: "Unknown setting." }
  const value = field(form, "value")
  try {
    await setSetting(key, value || null, owner.id)
  } catch (error) {
    return fail(error)
  }
  await audit(
    owner.id,
    "setting.update",
    { type: "setting", id: key },
    { value: value || null }
  )
  revalidatePath("/owner/config")
  return { message: value ? "Saved." : "Reset to the environment value." }
}

/* ─────────────────────────────── plans ──────────────────────────── */

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max)
const rupeesToPaise = z
  .string()
  .trim()
  .regex(/^\d{0,7}(\.\d{1,2})?$/, "Use rupees, e.g. 499 or 499.50")
  .transform((value) => (value === "" ? null : Math.round(Number(value) * 100)))
const rupeesToMicro = z
  .string()
  .trim()
  .regex(/^\d{0,7}(\.\d{1,6})?$/, "Use rupees, e.g. 150")
  .transform((value) => (value === "" ? 0 : Math.round(Number(value) * 1_000_000)))

const planSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200),
  priceRupees: rupeesToPaise,
  includedRupees: rupeesToMicro,
  markupBps: int(0, 1_000_000),
  maxAgents: int(0, 1000),
  maxConcurrentTasks: int(1, 50),
  maxTasksPerDay: int(0, 100_000),
  maxTaskSeconds: int(30, 7200),
  maxSteps: int(1, 200),
  maxTaskCostCents: z.coerce.number().min(0.01).max(10_000),
  allowedTiers: z.array(z.enum(TIERS)).min(1, "Allow at least one model level."),
  overageAllowed: z.boolean(),
  overageCapRupees: rupeesToMicro,
  warnAtPct: int(1, 100),
  active: z.boolean(),
  razorpayPlanId: z.string().trim().max(64),
})

export async function savePlan(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  const id = field(form, "id")
  const parsed = planSchema.safeParse({
    name: field(form, "name"),
    description: field(form, "description"),
    priceRupees: field(form, "priceRupees"),
    includedRupees: field(form, "includedRupees"),
    markupBps: field(form, "markupBps"),
    maxAgents: field(form, "maxAgents"),
    maxConcurrentTasks: field(form, "maxConcurrentTasks"),
    maxTasksPerDay: field(form, "maxTasksPerDay"),
    maxTaskSeconds: field(form, "maxTaskSeconds"),
    maxSteps: field(form, "maxSteps"),
    maxTaskCostCents: field(form, "maxTaskCostCents"),
    allowedTiers: form.getAll("allowedTiers"),
    overageAllowed: form.get("overageAllowed") === "on",
    overageCapRupees: field(form, "overageCapRupees"),
    warnAtPct: field(form, "warnAtPct"),
    active: form.get("active") === "on",
    razorpayPlanId: field(form, "razorpayPlanId"),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { error: `${issue.path.join(".")}: ${issue.message}` }
  }
  const data = parsed.data
  const [existing] = await privileged.select().from(plans).where(eq(plans.id, id))
  if (!existing) return { error: "Plan not found." }
  if (data.active && !existing.isDefault && data.priceRupees == null) {
    return { error: "Set a price before making a paid plan available." }
  }
  if (existing.isDefault && !data.active) {
    return { error: "The default plan must stay available." }
  }
  const values = {
    name: data.name,
    description: data.description || null,
    priceMonthlyPaise: existing.isDefault ? 0 : data.priceRupees,
    includedUsageMicroInr: data.includedRupees,
    markupBps: data.markupBps,
    maxAgents: data.maxAgents,
    maxConcurrentTasks: data.maxConcurrentTasks,
    maxTasksPerDay: data.maxTasksPerDay,
    maxTaskSeconds: data.maxTaskSeconds,
    maxSteps: data.maxSteps,
    // Entered in US cents, stored in micro-USD
    maxTaskCostMicroUsd: Math.round(data.maxTaskCostCents * 10_000),
    allowedTiers: data.allowedTiers,
    overageAllowed: data.overageAllowed,
    overageCapMicroInr: data.overageCapRupees,
    warnAtPct: data.warnAtPct,
    active: data.active,
    razorpayPlanId: data.razorpayPlanId || null,
  }
  await privileged.update(plans).set(values).where(eq(plans.id, id))
  await audit(owner.id, "plan.update", { type: "plan", id }, values)
  revalidatePath("/owner/config")
  return { message: `${data.name} saved.` }
}

/* ────────────────────────────── models ──────────────────────────── */

const modelId = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+\/[A-Za-z0-9._:~-]+$/, "Use an OpenRouter model id.")

export async function addModel(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  const id = modelId.safeParse(field(form, "id"))
  if (!id.success) return { error: id.error.issues[0].message }
  try {
    const result = await syncCatalogue([id.data])
    if (result.missing.length)
      return { error: `${id.data} isn't in OpenRouter's catalogue.` }
  } catch (error) {
    return fail(error)
  }
  await audit(owner.id, "model.add", { type: "model", id: id.data })
  revalidatePath("/owner/config")
  return {
    message: `${id.data} added with current prices. Run the eval before enabling it.`,
  }
}

export async function setModelEnabled(
  _: OwnerState,
  form: FormData
): Promise<OwnerState> {
  const owner = await requireOwner()
  const id = modelId.safeParse(field(form, "id"))
  const enabled = field(form, "enabled") === "true"
  if (!id.success) return { error: "Invalid model." }
  await privileged.update(models).set({ enabled }).where(eq(models.id, id.data))
  await audit(owner.id, enabled ? "model.enable" : "model.disable", {
    type: "model",
    id: id.data,
  })
  revalidatePath("/owner/config")
  return { message: `${id.data} ${enabled ? "enabled" : "disabled"}.` }
}

export async function refreshCatalogue(): Promise<OwnerState> {
  const owner = await requireOwner()
  const ids = (await privileged.select({ id: models.id }).from(models)).map(
    (row) => row.id
  )
  if (ids.length === 0) return { error: "Add a model first." }
  try {
    const result = await syncCatalogue(ids)
    await audit(owner.id, "model.sync", undefined, result)
    revalidatePath("/owner/config")
    return {
      message: `Prices refreshed for ${result.updated} model(s).${result.missing.length ? ` Not in the catalogue any more: ${result.missing.join(", ")}.` : ""}`,
    }
  } catch (error) {
    return fail(error)
  }
}

/* ──────────────────────────── operations ────────────────────────── */

// Requeues a failed task for one more attempt. Refused when it ran a tool
// with side effects (it could repeat something irreversible) or when the
// thread already has a task going.
export async function retryTask(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  const id = uuid.safeParse(field(form, "taskId"))
  if (!id.success) return { error: "Invalid task." }
  try {
    const [updated] = await privileged
      .update(tasks)
      .set({
        status: "queued",
        availableAt: new Date(),
        maxAttempts: sql`least(${tasks.attempts} + 1, 5)`,
        deadlineAt: new Date(Date.now() + 30 * 60_000),
        errorCode: null,
        error: null,
        finishedAt: null,
        cancelRequestedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(tasks.id, id.data),
          eq(tasks.status, "failed"),
          sql`${tasks.attempts} < 5`,
          sql`not exists (select 1 from kriya.tool_executions e where e.task_id = ${tasks.id} and e.side_effect)`
        )
      )
      .returning({ id: tasks.id })
    if (!updated) {
      return {
        error:
          "This task can't be retried (side effects, attempts used up, or not failed).",
      }
    }
  } catch (error) {
    if (isUniqueViolation(error, "tasks_one_active_per_thread")) {
      return { error: "That thread already has a task running." }
    }
    return fail(error)
  }
  await audit(owner.id, "task.retry", { type: "task", id: id.data })
  revalidatePath("/owner/operations")
  return { message: "Requeued." }
}

// Fills in provider costs that weren't reported at the time, from
// OpenRouter's generation records, then reprices the affected tasks
export async function reconcileUsage(): Promise<OwnerState> {
  const owner = await requireOwner()
  const key = getSecret("OPENROUTER_API_KEY")
  if (!key) return { error: "OPENROUTER_API_KEY is not set." }
  const pending = await privileged
    .select({
      id: usageEvents.id,
      generationId: usageEvents.generationId,
      taskId: usageEvents.taskId,
    })
    .from(usageEvents)
    .where(and(isNull(usageEvents.costMicroUsd), isNotNull(usageEvents.generationId)))
    .limit(40)
  const base = (
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "")
  let filled = 0
  const touched = new Set<string>()
  for (const row of pending) {
    try {
      const response = await fetch(
        `${base}/generation?id=${encodeURIComponent(row.generationId!)}`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        }
      )
      if (!response.ok) continue
      const body = (await response.json()) as { data?: { total_cost?: unknown } }
      const cost = creditsToMicroUsd(body.data?.total_cost)
      if (cost == null) continue
      await privileged
        .update(usageEvents)
        .set({ costMicroUsd: cost, costSource: "reconciled" })
        .where(eq(usageEvents.id, row.id))
      filled++
      if (row.taskId) touched.add(row.taskId)
    } catch (error) {
      log.warn("reconcile lookup failed", { error })
    }
  }
  if (touched.size > 0) {
    const affected = await privileged
      .select({ id: tasks.id, planId: tasks.planId })
      .from(tasks)
      .where(inArray(tasks.id, [...touched]))
    for (const task of affected) await repriceTask(task)
  }
  await audit(owner.id, "usage.reconcile", undefined, { checked: pending.length, filled })
  revalidatePath("/owner/operations")
  revalidatePath("/owner/finance")
  return {
    message: `Checked ${pending.length}, filled ${filled}, repriced ${touched.size} task(s).`,
  }
}
