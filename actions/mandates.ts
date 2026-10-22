"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { eq } from "drizzle-orm"

import { privileged, withUser, type Tx } from "@/db"
import { agents, auditEvents, mandates } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { PdfUnavailableError } from "@/lib/documents/render"
import { checkGoalAllowed, getPlan } from "@/lib/entitlements"
import { log } from "@/lib/log"
import { stopCrews } from "@/lib/operator/crews"
import * as jobs from "@/lib/operator/mandates"
import { fillPlaybook, playbookById, runnable } from "@/lib/operator/playbooks"
import { jobReportPdf } from "@/lib/share"
import { playbookNeeds } from "@/queries/mandates"

// The person's decisions on a job (O3, TOOLS_AND_CONTRACTS §2): approve with
// reduce-only edits, decline, pause, resume, revoke, close, revoke one grant,
// tick a criterion, or stop every job at once. No agent tool reaches these.

export type MandateActionResult = { ok: true } | { error: string }

const id = z.string().min(1).max(32)
const edits = z.object({
  drop: z.array(z.number().int().min(0).max(5)).max(6).optional(),
  maxUses: z
    .record(z.string().regex(/^[0-5]$/), z.number().int().min(1).max(50))
    .optional(),
})

const on = async (key: Parameters<typeof getSetting>[0]) =>
  (await getSetting(key)) === "on"
const maxActive = async () =>
  Number.parseInt((await getSetting("operator.maxActive")) ?? "", 10) || 3

// Session, switch and input checked; the change runs as the person
async function act(
  mandateId: unknown,
  change: (tx: Tx, userId: string, id: string) => Promise<unknown>,
  fallback: string
): Promise<MandateActionResult> {
  const user = await requireUser()
  if (!(await on("operator.mandates"))) return { error: "Jobs aren't available yet." }
  const parsed = id.safeParse(mandateId)
  if (!parsed.success) return { error: "That job wasn't found." }
  try {
    await withUser(user.id, (tx) => change(tx, user.id, parsed.data))
  } catch (error) {
    return { error: jobs.explainMandate(error, fallback) }
  }
  revalidatePath("/", "layout")
  return { ok: true }
}

export async function approveMandate(
  mandateId: string,
  changes: z.input<typeof edits> = {}
): Promise<{ ok: true; goalId: string } | { error: string }> {
  const user = await requireUser()
  // Jobs live on goals, and their proof is "What I did" (OD-21)
  if (!(await on("operator.mandates"))) return { error: "Jobs aren't available yet." }
  if (!(await on("agents.goals")) || !(await on("agents.inbox")))
    return { error: "Jobs need goals and the Inbox, which aren't switched on yet." }
  const parsedId = id.safeParse(mandateId)
  const parsedEdits = edits.safeParse(changes)
  if (!parsedId.success || !parsedEdits.success)
    return { error: "That request wasn't valid." }
  const goal = await checkGoalAllowed(user.id)
  if (!goal.ok) return { error: goal.message }
  const plan = await getPlan(user.id)
  const limits = {
    maxActive: await maxActive(),
    maxSchedules: plan.maxSchedules,
    minScheduleIntervalMinutes: plan.minScheduleIntervalMinutes,
  }
  try {
    const { goalId } = await withUser(user.id, (tx) =>
      jobs.approveMandate(tx, parsedId.data, parsedEdits.data, limits)
    )
    revalidatePath("/", "layout")
    return { ok: true, goalId }
  } catch (error) {
    return { error: jobs.explainMandate(error, "Couldn't start the job. Try again.") }
  }
}

export async function declineMandate(mandateId: string) {
  return act(
    mandateId,
    (tx, _, id) => jobs.declineMandate(tx, id),
    "Couldn't decline it."
  )
}

export async function pauseMandate(mandateId: string) {
  return act(mandateId, (tx, _, id) => jobs.pauseMandate(tx, id), "Couldn't pause it.")
}

export async function resumeMandate(mandateId: string) {
  const limit = await maxActive()
  return act(
    mandateId,
    (tx, _, id) => jobs.resumeMandate(tx, id, limit),
    "Couldn't resume it."
  )
}

// O11: a job that ends takes its crew with it at once (the worker's pass
// would a tick later). Every row is scoped by the signed-in person's id.
async function endCrews(mandateId?: string) {
  if (!(await on("operator.crews"))) return
  const user = await requireUser()
  await stopCrews(user.id, mandateId).catch((error) =>
    log.error("crew stop failed", { mandateId, error })
  )
}

export async function revokeMandate(mandateId: string) {
  const result = await act(
    mandateId,
    (tx, _, id) => jobs.endMandate(tx, id, "revoked"),
    "Couldn't revoke it."
  )
  if ("ok" in result) await endCrews(mandateId)
  return result
}

export async function closeMandate(mandateId: string) {
  const result = await act(
    mandateId,
    (tx, _, id) => jobs.endMandate(tx, id, "closed"),
    "Couldn't close it."
  )
  if ("ok" in result) await endCrews(mandateId)
  return result
}

// O11: the person stops a job's crew; the job itself carries on
export async function stopCrew(mandateId: string): Promise<MandateActionResult> {
  const user = await requireUser()
  if (!(await on("operator.mandates")) || !(await on("operator.crews")))
    return { error: "Crews aren't available yet." }
  const parsed = id.safeParse(mandateId)
  if (!parsed.success) return { error: "That job wasn't found." }
  // Through RLS: someone else's job finds nothing
  const [job] = await withUser(user.id, (tx) =>
    tx.select({ id: mandates.id }).from(mandates).where(eq(mandates.id, parsed.data))
  )
  if (!job) return { error: "That job wasn't found." }
  try {
    await stopCrews(user.id, job.id)
  } catch (error) {
    log.error("crew stop failed", { mandateId: job.id, error })
    return { error: "Couldn't stop the crew. Try again." }
  }
  revalidatePath("/", "layout")
  return { ok: true }
}

export async function revokeGrant(grantId: string): Promise<MandateActionResult> {
  const user = await requireUser()
  if (!(await on("operator.mandates"))) return { error: "Jobs aren't available yet." }
  const parsed = z.uuid().safeParse(grantId)
  if (!parsed.success) return { error: "That permission wasn't found." }
  try {
    await withUser(user.id, (tx) => jobs.revokeGrant(tx, parsed.data))
  } catch (error) {
    return { error: jobs.explainMandate(error, "Couldn't revoke it.") }
  }
  revalidatePath("/", "layout")
  return { ok: true }
}

export async function confirmCriterion(mandateId: string, criterionId: string) {
  const criterion = z
    .string()
    .regex(/^c\d{1,2}$/)
    .safeParse(criterionId)
  if (!criterion.success) return { error: "That line wasn't found." }
  return act(
    mandateId,
    (tx, _, id) => jobs.confirmCriterion(tx, id, criterion.data),
    "Couldn't mark it done."
  )
}

export async function stopAllMandates(): Promise<
  { ok: true; stopped: number } | { error: string }
> {
  const user = await requireUser()
  if (!(await on("operator.mandates"))) return { error: "Jobs aren't available yet." }
  let stopped: number
  try {
    stopped = await withUser(user.id, (tx) => jobs.stopAllMandates(tx))
  } catch (error) {
    return { error: jobs.explainMandate(error, "Couldn't stop your jobs. Try again.") }
  }
  await endCrews()
  await privileged.insert(auditEvents).values({
    actorId: user.id,
    action: "mandates.stop_all",
    targetType: "user",
    targetId: user.id,
    details: { stopped },
  })
  revalidatePath("/", "layout")
  return { ok: true, stopped }
}

// O5: the handover report as the person's PDF, with the verdict as of now.
// Rendered from the existing `report` template; read as the person.
export async function mandateReportPdf(
  mandateId: string
): Promise<{ ok: true; fileId: string } | { error: string }> {
  const user = await requireUser()
  if (
    !(await on("operator.mandates")) ||
    !(await on("operator.reports")) ||
    !(await on("agents.files"))
  )
    return { error: "Job reports aren't available yet." }
  const parsed = id.safeParse(mandateId)
  if (!parsed.success) return { error: "That job wasn't found." }
  try {
    const made = await jobReportPdf(user.id, parsed.data)
    if (!made) return { error: "That job wasn't found." }
    return { ok: true, fileId: made.file.id }
  } catch (error) {
    if (error instanceof PdfUnavailableError) return { error: error.message }
    throw error
  }
}

// O7: the person hands Kriya a job from a playbook. It becomes the same
// proposal card an agent's would (proposed_by person), approved as usual.
// Pins come only from these slots; the 10-item limits keep the work prompt
// within a schedule's 2000 characters.
const slotsInput = z.object({
  invoices: z.array(z.uuid()).max(10).optional(),
  emails: z.array(z.email().max(320)).max(10).optional(),
  sheet: z
    .object({
      spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
      range: z.string().min(1).max(200),
    })
    .optional(),
  text: z.string().trim().min(1).max(1000).optional(),
  date: z
    .string()
    .regex(/^20\d{2}-(0[1-9]|1[0-2])$/)
    .optional(),
})

export async function proposeFromPlaybook(
  playbookId: string,
  slots: z.input<typeof slotsInput>,
  agentId: string
): Promise<{ ok: true; mandateId: string } | { error: string }> {
  const user = await requireUser()
  if (!(await on("operator.mandates")) || !(await on("operator.playbooks")))
    return { error: "Jobs aren't available yet." }
  const playbook = playbookById(playbookId)
  const parsed = slotsInput.safeParse(slots)
  const agent = id.safeParse(agentId)
  if (!playbook || !parsed.success || !agent.success)
    return { error: "That request wasn't valid." }
  // The same check as the picker, on the server
  if (!runnable(await playbookNeeds(user.id)).includes(playbook))
    return { error: "This job needs an account or feature you haven't connected." }
  const [mine] = await withUser(user.id, (tx) =>
    tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.data))
  )
  if (!mine) return { error: "Pick one of your agents." }
  const proposal = fillPlaybook(playbook, parsed.data)
  if ("error" in proposal) return { error: proposal.error! }
  const result = await jobs.proposeMandate(
    { userId: user.id, agentId: mine.id, proposedBy: "person" },
    proposal
  )
  if ("error" in result) return { error: Object.values(result.fields)[0] ?? result.error }
  revalidatePath("/", "layout")
  return { ok: true, mandateId: result.mandateId }
}
