import { and, count, eq, inArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import { z } from "zod"

import { withUser, type Tx } from "@/db"
import {
  goals,
  grants,
  invoices,
  ledgerEntries,
  mandates,
  schedules,
  threads,
  VOICE_TASK_RESULTS,
  type GrantTool,
  type Mandate,
  type ProposedGrant,
} from "@/db/schema"
import { createGoal, explain, setGoalBudget, setGoalStatus } from "@/lib/goals"
import { PIN_SCHEMAS } from "@/lib/operator/pins"
import { playbookById } from "@/lib/operator/playbooks"
import { quoteFor } from "@/lib/quotes"
import {
  createSchedule,
  minGapMinutes,
  ruleSchema,
  ScheduleError,
  setScheduleCap,
  setScheduleStatus,
} from "@/lib/schedules"

// Jobs (track O, O3; docs/operator/TOOLS_AND_CONTRACTS.md §1–2). An agent
// proposes one; only the person approves, pauses, resumes, revokes, closes
// or ticks it, through actions/mandates.ts. Everything that changes a job
// runs inside the caller's withUser transaction, so another person's job
// simply isn't found.

export class MandateError extends Error {}

// Open proposals per person: proposals grant nothing, this only stops a flood
export const MAX_OPEN_PROPOSALS = 5
// Active and needs-you jobs count against operator.maxActive (OD-14)
const RUNNING = ["active", "needs_person"] as const
const OPEN = ["active", "needs_person", "paused"] as const
const DEFAULT_CHECK_IN = { freq: "daily", at: "10:00" } as const
const DAY_MINUTES = 1440

const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_verified"),
    tool: z.string().min(1).max(40),
    atLeast: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    kind: z.literal("call_outcome"),
    results: z.array(z.enum(VOICE_TASK_RESULTS)).min(1).max(8),
  }),
  z.object({ kind: z.literal("invoice_paid") }),
  z.object({ kind: z.literal("ledger_confirmed") }),
  z.object({ kind: z.literal("file_created") }),
  z.object({ kind: z.literal("person_confirmed") }),
])

export const proposalSchema = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2000),
  playbookId: z
    .string()
    .regex(/^OP-[A-Z]{2,12}$/)
    .optional(),
  criteria: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        evidence: evidenceSchema.describe(
          "What proves it: tool_verified {tool, atLeast} (a checked run of that tool), call_outcome {results}, invoice_paid, ledger_confirmed, file_created, or person_confirmed (the person ticks it)"
        ),
      })
    )
    .min(1)
    .max(12)
    .describe("What done means, each line with its proof"),
  grants: z
    .array(
      z.object({
        tool: z.string().min(1).max(40),
        pins: z
          .record(z.string(), z.unknown())
          .describe(
            "gmail_draft {to, cc?}, calendar_create_event {attendees}, sheets_append/sheets_update {spreadsheetId, range}"
          ),
        maxUses: z.number().int().min(1).max(50),
        why: z.string().min(1).max(200),
      })
    )
    .max(6)
    .default([])
    .describe("Actions Kriya may repeat without asking, pinned to these targets"),
  dueInDays: z.number().int().min(1).max(30),
  budgetInr: z.number().int().min(1).max(1_00_000).optional(),
  checkIn: ruleSchema.optional().describe("At most daily; default daily at 10:00 IST"),
  subjects: z
    .object({
      invoices: z.array(z.uuid()).max(20).optional(),
      ledger: z.array(z.uuid()).max(50).optional(),
    })
    .optional(),
})

export type ProposeEnv = {
  userId: string
  // The chat it was proposed in; none when the person starts a playbook
  threadId?: string | null
  taskId?: string
  agentId: string
  proposedBy?: "agent" | "person"
}

type Refusal = { error: string; fields: Record<string, string> }
const refuse = (fields: Record<string, string>): Refusal => ({
  error: "Kriya can't propose this job as it stands.",
  fields,
})

const NOTE =
  "A proposal. The person reviews and approves it in Kriya; nothing is granted until then. You can't approve it."

/* ───────────────────────────── propose ──────────────────────────── */

export async function proposeMandate(env: ProposeEnv, input: unknown) {
  const parsed = proposalSchema.safeParse(input)
  if (!parsed.success) {
    return refuse(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message]))
    )
  }
  const proposal = parsed.data
  const fields: Record<string, string> = {}
  // Loaded here: the registry reads lib/agent/tools.ts, which holds this tool
  const { CAPABILITIES, GRANTABLE } = await import("@/lib/agent/capabilities")

  // Grantable tools only (OD-03), each pinned (DATA_MODEL §2.2)
  const proposedGrants: ProposedGrant[] = []
  proposal.grants.forEach((grant, i) => {
    if (!GRANTABLE.has(grant.tool)) {
      fields[`grants.${i}.tool`] = `${grant.tool} can't be granted; it asks each time.`
      return
    }
    const pins = PIN_SCHEMAS[grant.tool as GrantTool].safeParse(grant.pins)
    if (!pins.success) {
      fields[`grants.${i}.pins`] = pins.error.issues
        .map((issue) => `${issue.path.join(".") || "pins"}: ${issue.message}`)
        .join("; ")
      return
    }
    proposedGrants.push({
      tool: grant.tool as GrantTool,
      pins: pins.data,
      maxUses: grant.maxUses,
      why: grant.why,
    })
  })

  // A criterion Kriya could never check is refused now, not left unmet later
  proposal.criteria.forEach(({ evidence }, i) => {
    if (evidence.kind !== "tool_verified") return
    const capability = CAPABILITIES[evidence.tool]
    const checkable =
      capability &&
      (capability.risk === "R2" ||
        capability.risk === "R3" ||
        capability.verification !== "none")
    if (!checkable)
      fields[`criteria.${i}.evidence`] =
        `Kriya can't check ${evidence.tool} runs, so this could never be met.`
  })
  const needs = (kind: string) => proposal.criteria.some((c) => c.evidence.kind === kind)
  if (
    proposal.checkIn &&
    (proposal.checkIn.freq === "once" || minGapMinutes(proposal.checkIn) < DAY_MINUTES)
  )
    fields.checkIn = "Check in at most once a day, on a repeating rule."

  // A playbook id names a playbook; the job keeps its version (OD-09)
  const playbook = playbookById(proposal.playbookId)
  if (proposal.playbookId && !playbook) fields.playbookId = "No playbook has that id."
  const invoiceIds = [...new Set(proposal.subjects?.invoices ?? [])]
  const ledgerIds = [...new Set(proposal.subjects?.ledger ?? [])]

  const result = await withUser(env.userId, async (tx) => {
    if (env.taskId) {
      const [existing] = await tx
        .select({ id: mandates.id })
        .from(mandates)
        .where(and(eq(mandates.taskId, env.taskId), eq(mandates.title, proposal.title)))
      if (existing) return { mandateId: existing.id }
    }

    // The person's own records only (RLS), and only invoices still owed
    const owed = invoiceIds.length
      ? await tx
          .select({ id: invoices.id, status: invoices.status })
          .from(invoices)
          .where(inArray(invoices.id, invoiceIds))
      : []
    if (owed.length < invoiceIds.length)
      fields["subjects.invoices"] = "Some of these invoices weren't found."
    else if (needs("invoice_paid") && invoiceIds.length === 0)
      fields["subjects.invoices"] = "List the invoices that have to be paid."
    else if (needs("invoice_paid") && owed.some((row) => row.status !== "issued"))
      fields["subjects.invoices"] = "Only issued invoices can be waited on for payment."
    const entries = ledgerIds.length
      ? await tx
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(inArray(ledgerEntries.id, ledgerIds))
      : []
    if (entries.length < ledgerIds.length)
      fields["subjects.ledger"] = "Some of these ledger entries weren't found."
    // OP-BOOKS starts empty: entries join as they're drafted (loop.ts)
    else if (
      needs("ledger_confirmed") &&
      ledgerIds.length === 0 &&
      !playbook?.growsLedger
    )
      fields["subjects.ledger"] = "List the entries that have to be confirmed."

    const [open] = await tx
      .select({ n: count() })
      .from(mandates)
      .where(eq(mandates.status, "proposed"))
    if ((open?.n ?? 0) >= MAX_OPEN_PROPOSALS)
      fields.proposals = `There are already ${MAX_OPEN_PROPOSALS} jobs waiting for the person to decide.`
    if (Object.keys(fields).length > 0) return refuse(fields)

    const [thread] = await tx
      .select({ squadId: threads.squadId })
      .from(threads)
      .where(eq(threads.id, env.threadId ?? ""))
    const id = nanoid(12)
    const now = Date.now()
    await tx.insert(mandates).values({
      id,
      userId: env.userId,
      originThreadId: env.threadId ?? null,
      agentId: env.agentId,
      squadId: thread?.squadId ?? null,
      playbookId: playbook?.id ?? null,
      playbookVersion: playbook?.version ?? null,
      title: proposal.title,
      objective: proposal.objective,
      criteria: proposal.criteria.map((c, i) => ({ id: `c${i + 1}`, ...c })),
      proposedGrants,
      subjects: {
        ...(invoiceIds.length && { invoices: invoiceIds }),
        ...(ledgerIds.length && { ledger: ledgerIds }),
      },
      // A minute inside the database's 30-day check, so clock skew never trips it
      dueAt: new Date(now + proposal.dueInDays * 86_400_000 - 60_000),
      budgetMicroInr: proposal.budgetInr ? proposal.budgetInr * 1_000_000 : null,
      checkIn: proposal.checkIn ?? null,
      proposedBy: env.proposedBy ?? "agent",
      taskId: env.taskId ?? null,
    })
    return { mandateId: id }
  })
  if ("error" in result) return result
  return {
    mandateId: result.mandateId,
    href: "/inbox",
    quote: proposal.playbookId
      ? await quoteFor(env.userId, { workflowId: proposal.playbookId })
      : null,
    note: NOTE,
  }
}

// A job and how far it got, for mandate_status: by id, or the job whose goal
// thread this is. "met" is the last verdict Kriya stored (O5) or the
// person's tick, never the model's word.
export async function mandateStatus(
  userId: string,
  threadId: string,
  mandateId?: string
) {
  return withUser(userId, async (tx) => {
    const [row] = mandateId
      ? await tx
          .select({ job: mandates })
          .from(mandates)
          .where(eq(mandates.id, mandateId))
      : await tx
          .select({ job: mandates })
          .from(mandates)
          .innerJoin(goals, eq(goals.id, mandates.goalId))
          .where(eq(goals.threadId, threadId))
    if (!row) return { error: "No job found here. Give its id." }
    const { job } = row
    const held = await tx
      .select({
        tool: grants.tool,
        uses: grants.uses,
        maxUses: grants.maxUses,
        status: grants.status,
      })
      .from(grants)
      .where(eq(grants.mandateId, job.id))
    return {
      mandateId: job.id,
      title: job.title,
      status: job.status,
      dueAt: job.dueAt.toISOString(),
      criteria: job.criteria.map((c) => {
        const result = job.verdict?.find((v) => v.id === c.id)
        return {
          id: c.id,
          text: c.text,
          met: job.confirmed.includes(c.id) || Boolean(result?.met),
          refs: result?.refs ?? [],
        }
      }),
      grants: held,
    }
  })
}

/* ─────────────────────────── the person's ───────────────────────── */

async function lock(tx: Tx, id: string) {
  const [job] = await tx.select().from(mandates).where(eq(mandates.id, id)).for("update")
  if (!job) throw new MandateError("That job wasn't found.")
  return job
}

async function roomFor(tx: Tx, maxActive: number) {
  const [row] = await tx
    .select({ n: count() })
    .from(mandates)
    .where(inArray(mandates.status, RUNNING))
  if ((row?.n ?? 0) >= maxActive)
    throw new MandateError(
      `You can have ${maxActive} jobs running at once. Close one to start this.`
    )
}

const isOpen = (job: Mandate) => (OPEN as readonly string[]).includes(job.status)

export type Limits = {
  maxActive: number
  // The person's plan (lib/entitlements.ts getPlan)
  maxSchedules: number
  minScheduleIntervalMinutes: number
}

// Reduce-only edits (OD-02): drop a grant by its index, or lower its uses
export type ApprovalEdits = { drop?: number[]; maxUses?: Record<string, number> }

const kickoffPrompt = (job: Mandate) =>
  `Start the job "${job.title}", which the person approved. The goal's checklist says what done means. ${job.objective}`.slice(
    0,
    2000
  )
// A playbook job's objective is its work prompt, so its check-ins carry it
const checkInPrompt = (job: Mandate) =>
  `Check in on the job "${job.title}": see what changed since the last run, take the next step the job allows, and say plainly what is left or what you need from the person.${job.playbookId ? ` The job: ${job.objective}` : ""}`.slice(
    0,
    2000
  )

// One transaction: the goal and its thread, the grants as edited, the
// kickoff (in a minute: a `once` at "now" is already past) and the
// check-ins, the ₹ caps, then the job itself. Any failure undoes it all.
export async function approveMandate(
  tx: Tx,
  id: string,
  edits: ApprovalEdits,
  limits: Limits,
  now = new Date()
) {
  const job = await lock(tx, id)
  if (job.status !== "proposed") throw new MandateError("This job was already decided.")
  await roomFor(tx, limits.maxActive)

  const drop = new Set(edits.drop ?? [])
  const lowered = Object.entries(edits.maxUses ?? {}).map(([i, n]) => [Number(i), n])
  const indices = [...drop, ...lowered.map(([i]) => i)]
  if (
    indices.some((i) => !Number.isInteger(i) || i < 0 || i >= job.proposedGrants.length)
  )
    throw new MandateError("This job doesn't ask for that permission.")
  const kept = job.proposedGrants.flatMap((grant, i) => {
    if (drop.has(i)) return []
    const maxUses = lowered.find(([index]) => index === i)?.[1] ?? grant.maxUses
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > grant.maxUses)
      throw new MandateError("You can only lower a limit, not raise it.")
    return [{ ...grant, maxUses }]
  })

  const checkIn = ruleSchema.safeParse(job.checkIn ?? DEFAULT_CHECK_IN)
  if (!checkIn.success)
    throw new MandateError("Kriya can't read this job's check-in time.")
  if (minGapMinutes(checkIn.data) < limits.minScheduleIntervalMinutes)
    throw new MandateError("Your plan doesn't allow check-ins that often.")
  const lead = job.agentId
  if (!lead) throw new MandateError("No agent is left to work on this job.")

  const plan = job.criteria.map((c) => c.text)
  let goalId: string
  let threadId: string
  if (job.squadId) {
    // createGoal makes single-agent goals; a squad's job gets a squad thread
    goalId = nanoid(12)
    threadId = nanoid(12)
    await tx.insert(threads).values({
      id: threadId,
      userId: job.userId,
      squadId: job.squadId,
      title: job.title.slice(0, 80),
    })
    await tx.insert(goals).values({
      id: goalId,
      userId: job.userId,
      squadId: job.squadId,
      threadId,
      title: job.title,
      successCriteria: plan.join("\n"),
      plan: plan.map((text) => ({ id: nanoid(6), text, status: "todo" as const })),
    })
  } else {
    ;({ goalId, threadId } = await createGoal(tx, {
      userId: job.userId,
      agentId: lead,
      title: job.title,
      successCriteria: plan.join("\n"),
      plan,
    }))
  }

  if (kept.length > 0) {
    await tx.insert(grants).values(
      kept.map((grant) => ({
        userId: job.userId,
        mandateId: job.id,
        tool: grant.tool,
        pins: grant.pins,
        maxUses: grant.maxUses,
        expiresAt: job.dueAt,
      }))
    )
  }

  const base = { userId: job.userId, agentId: lead, threadId, goalId }
  const runs = [
    await createSchedule(
      tx,
      {
        ...base,
        id: nanoid(12),
        prompt: kickoffPrompt(job),
        rule: { freq: "once", startAt: new Date(now.getTime() + 60_000).toISOString() },
      },
      now
    ),
    await createSchedule(
      tx,
      { ...base, id: nanoid(12), prompt: checkInPrompt(job), rule: checkIn.data },
      now
    ),
  ]
  const [held] = await tx
    .select({ n: count() })
    .from(schedules)
    .where(inArray(schedules.status, ["active", "paused"]))
  if ((held?.n ?? 0) > limits.maxSchedules)
    throw new MandateError(
      `Your plan includes ${limits.maxSchedules} schedules and a job needs 2. End one to start this job.`
    )
  if (job.budgetMicroInr) {
    await setGoalBudget(tx, goalId, job.budgetMicroInr)
    for (const run of runs) await setScheduleCap(tx, run.id, job.budgetMicroInr)
  }

  await tx
    .update(mandates)
    .set({ status: "active", approvedAt: now, goalId })
    .where(eq(mandates.id, id))
  return { goalId, threadId }
}

export async function declineMandate(tx: Tx, id: string) {
  const job = await lock(tx, id)
  if (job.status !== "proposed") throw new MandateError("This job was already decided.")
  await tx
    .update(mandates)
    .set({ status: "declined", closedAt: new Date() })
    .where(eq(mandates.id, id))
}

// The goal pauses with it, and so do its schedules
export async function pauseMandate(tx: Tx, id: string) {
  const job = await lock(tx, id)
  if (job.status !== "active") throw new MandateError("Only an active job can be paused.")
  await tx.update(mandates).set({ status: "paused" }).where(eq(mandates.id, id))
  if (job.goalId) await setGoalStatus(tx, job.goalId, "paused")
}

// Paused or stuck → active; the schedules the job or its goal paused run again
export async function resumeMandate(
  tx: Tx,
  id: string,
  maxActive: number,
  now = new Date()
) {
  const job = await lock(tx, id)
  if (job.status !== "paused" && job.status !== "needs_person")
    throw new MandateError("Only a paused job, or one that needs you, can be resumed.")
  // A stuck job is already counted
  if (job.status === "paused") await roomFor(tx, maxActive)
  await tx
    .update(mandates)
    .set({ status: "active", statusReason: null })
    .where(eq(mandates.id, id))
  if (!job.goalId) return
  await setGoalStatus(tx, job.goalId, "active")
  const paused = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        eq(schedules.goalId, job.goalId),
        eq(schedules.status, "paused"),
        // The goal's ₹ budget pauses them again if it's still reached
        inArray(schedules.pauseReason, ["goal", "mandate", "budget"])
      )
    )
  for (const schedule of paused) {
    try {
      await setScheduleStatus(tx, schedule.id, "active", now)
    } catch (error) {
      // A kickoff whose minute has passed stays as it is
      if (!(error instanceof ScheduleError)) throw error
    }
  }
}

// Revoked or closed early: grants revoked, schedules ended, goal abandoned
export async function endMandate(
  tx: Tx,
  id: string,
  status: "revoked" | "closed",
  now = new Date()
) {
  const job = await lock(tx, id)
  if (!isOpen(job))
    throw new MandateError(
      job.status === "proposed"
        ? "This job hasn't started. Decline it instead."
        : "This job has already ended."
    )
  await tx.update(mandates).set({ status, closedAt: now }).where(eq(mandates.id, id))
  await tx
    .update(grants)
    .set({ status: "revoked", revokedAt: now })
    .where(and(eq(grants.mandateId, id), eq(grants.status, "active")))
  if (!job.goalId) return
  const [goal] = await tx
    .select({ status: goals.status })
    .from(goals)
    .where(eq(goals.id, job.goalId))
  if (goal && goal.status !== "achieved" && goal.status !== "abandoned")
    await setGoalStatus(tx, job.goalId, "abandoned")
}

export async function revokeGrant(tx: Tx, grantId: string) {
  const rows = await tx
    .update(grants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(eq(grants.id, grantId), eq(grants.status, "active")))
    .returning({ id: grants.id })
  if (rows.length === 0) throw new MandateError("That permission isn't active.")
}

// Only criteria the person is the proof of (OD-05)
export async function confirmCriterion(tx: Tx, id: string, criterionId: string) {
  const job = await lock(tx, id)
  if (!isOpen(job)) throw new MandateError("Only a running job can be ticked off.")
  const criterion = job.criteria.find((c) => c.id === criterionId)
  if (criterion?.evidence.kind !== "person_confirmed")
    throw new MandateError(
      "Kriya checks this one from what was done; it can't be ticked."
    )
  if (job.confirmed.includes(criterionId)) return
  await tx
    .update(mandates)
    .set({ confirmed: [...job.confirmed, criterionId] })
    .where(eq(mandates.id, id))
}

// Emergency stop: every open job of the person, in the caller's transaction
export async function stopAllMandates(tx: Tx, now = new Date()) {
  const open = await tx
    .select({ id: mandates.id })
    .from(mandates)
    .where(inArray(mandates.status, OPEN))
  for (const job of open) await endMandate(tx, job.id, "revoked", now)
  return open.length
}

export function explainMandate(error: unknown, fallback: string) {
  return error instanceof MandateError ? error.message : explain(error, fallback)
}
