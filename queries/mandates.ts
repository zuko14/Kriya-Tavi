import { and, asc, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm"

import { withUser, type Tx } from "@/db"
import {
  agents,
  approvals,
  connections,
  crewParts,
  crewRuns,
  goals,
  grants,
  invoices,
  mandates,
  schedules,
} from "@/db/schema"
import { getSetting } from "@/lib/config"
import { googleServices } from "@/lib/connectors"
import { getPlan } from "@/lib/entitlements"
import { formatPaise } from "@/lib/money"
import { isWebConfigured } from "@/lib/web"
import { crewThreadIds } from "@/lib/operator/crew-threads"
import type { Need } from "@/lib/operator/playbooks"
import { describeResult, loadEvidence, verdict } from "@/lib/operator/verdict"
import { describeRule, ruleSchema } from "@/lib/schedules"

// Jobs for the Inbox, the goal page and Settings (O3, UX_SPEC §1–5), read as
// the person: another person's job simply isn't there.

const checkInOf = (rule: unknown) => {
  const parsed = ruleSchema.safeParse(rule ?? { freq: "daily", at: "10:00" })
  // Read after "checks in": "every day at 10:00 am"
  const text = parsed.success ? describeRule(parsed.data) : "on a time Kriya can't read"
  return text.charAt(0).toLowerCase() + text.slice(1)
}

// The two Inbox sections: proposals to review, and jobs that need the person
export async function inboxJobs(tx: Tx) {
  const rows = await tx
    .select()
    .from(mandates)
    .where(inArray(mandates.status, ["proposed", "needs_person"]))
    .orderBy(desc(mandates.createdAt))
    .limit(20)
  return {
    review: rows
      .filter((m) => m.status === "proposed")
      .map((m) => ({
        id: m.id,
        title: m.title,
        objective: m.objective,
        playbookId: m.playbookId,
        dueAt: m.dueAt,
        checkIn: checkInOf(m.checkIn),
        criteria: m.criteria,
        grants: m.proposedGrants,
        budgetMicroInr: m.budgetMicroInr,
      })),
    needs: rows
      .filter((m) => m.status === "needs_person")
      .map((m) => ({
        id: m.id,
        title: m.title,
        reason: m.statusReason,
        goalId: m.goalId,
      })),
  }
}

export type InboxJobs = Awaited<ReturnType<typeof inboxJobs>>

// The job panel of a goal that a job owns, or null. With reports on, each
// done line is checked against the records now (O5), read as the person.
export async function jobForGoal(userId: string, goalId: string, reports = false) {
  return withUser(userId, async (tx) => {
    const [job] = await tx.select().from(mandates).where(eq(mandates.goalId, goalId))
    if (!job) return null
    const results = reports
      ? verdict(job.criteria, job.subjects, await loadEvidence(tx, userId, job))
      : null
    const held = await tx
      .select()
      .from(grants)
      .where(eq(grants.mandateId, job.id))
      .orderBy(asc(grants.createdAt))
    const [goal] = await tx
      .select({ threadId: goals.threadId })
      .from(goals)
      .where(eq(goals.id, goalId))
    // O11: approvals in its crew's part threads wait on the person too
    const threadIds = goal
      ? [goal.threadId, ...(await crewThreadIds(tx, userId, job.id))]
      : []
    const [waiting] = goal
      ? await tx
          .select({ n: count() })
          .from(approvals)
          .where(
            and(
              inArray(approvals.threadId, threadIds),
              eq(approvals.status, "pending"),
              gt(approvals.expiresAt, sql`now()`)
            )
          )
      : [{ n: 0 }]
    const [next] = await tx
      .select({ at: schedules.nextRunAt })
      .from(schedules)
      .where(
        and(
          eq(schedules.goalId, goalId),
          eq(schedules.status, "active"),
          eq(schedules.kind, "recurring")
        )
      )
      .limit(1)
    return {
      job,
      grants: held,
      crew: await latestCrew(tx, job.id),
      waiting: waiting?.n ?? 0,
      nextCheckIn: next?.at ?? null,
      checkIn: checkInOf(job.checkIn),
      // Per criterion id: met, and its line ("Verified · 2 records")
      checked: results
        ? Object.fromEntries(
            results.map((r) => [r.id, { met: r.met, line: describeResult(r) }])
          )
        : null,
      reports,
    }
  })
}

export type JobView = NonNullable<Awaited<ReturnType<typeof jobForGoal>>>

// O11: the job's latest crew and each part's member and status, or null
async function latestCrew(tx: Tx, mandateId: string) {
  const [run] = await tx
    .select()
    .from(crewRuns)
    .where(eq(crewRuns.mandateId, mandateId))
    .orderBy(desc(crewRuns.round))
    .limit(1)
  if (!run) return null
  const parts = await tx
    .select({
      key: crewParts.key,
      status: crewParts.status,
      agentId: crewParts.agentId,
      threadId: crewParts.threadId,
      name: agents.name,
    })
    .from(crewParts)
    .leftJoin(agents, eq(agents.id, crewParts.agentId))
    .where(eq(crewParts.runId, run.id))
    .orderBy(asc(crewParts.createdAt))
  return { status: run.status, round: run.round, parts }
}

// Settings → Jobs: what's running and the authority each holds
export async function openJobs(userId: string) {
  return withUser(userId, async (tx) => {
    const jobs = await tx
      .select()
      .from(mandates)
      .where(inArray(mandates.status, ["active", "needs_person", "paused"]))
      .orderBy(desc(mandates.createdAt))
    const held = jobs.length
      ? await tx
          .select()
          .from(grants)
          .where(
            and(
              inArray(
                grants.mandateId,
                jobs.map((j) => j.id)
              ),
              eq(grants.status, "active")
            )
          )
      : []
    return jobs.map((job) => ({
      ...job,
      grants: held.filter((g) => g.mandateId === job.id),
    }))
  })
}

// O7: what the person's playbooks can rely on (connections and switches),
// so the picker shows no dead buttons. Read as the person; scopes only.
export async function playbookNeeds(userId: string) {
  const [accounts, plan, ledgerOn, radarOn] = await Promise.all([
    withUser(userId, (tx) =>
      tx
        .select({ provider: connections.provider, scopes: connections.scopes })
        .from(connections)
    ),
    getPlan(userId),
    getSetting("agents.ledger"),
    getSetting("agents.radar"),
  ])
  const google = googleServices(
    accounts.find((a) => a.provider === "google")?.scopes ?? []
  )
  const have = new Set<Need>()
  if (google.includes("gmail")) have.add("google.gmail")
  if (google.includes("calendar")) have.add("google.calendar")
  if (google.includes("sheets")) have.add("google.sheets")
  if (plan.ledgerEnabled && ledgerOn === "on") have.add("ledger")
  if (radarOn === "on") have.add("radar")
  if (isWebConfigured()) have.add("web")
  return have
}

// The slot form's choices: the person's agents, and issued invoices past due
export async function playbookChoices(userId: string) {
  return withUser(userId, async (tx) => {
    const team = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .orderBy(asc(agents.createdAt))
    const overdue = await tx
      .select({
        id: invoices.id,
        number: invoices.numberText,
        client: invoices.client,
        total: invoices.totalPaise,
        dueDate: invoices.dueDate,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.status, "issued"),
          lt(invoices.dueDate, sql`(now() at time zone 'Asia/Kolkata')::date`)
        )
      )
      .orderBy(asc(invoices.dueDate))
      .limit(20)
    return {
      agents: team,
      invoices: overdue.map((i) => ({
        id: i.id,
        label: `${i.number ?? "Invoice"} · ${i.client.name ?? "client"} · ${formatPaise(i.total)} · due ${i.dueDate}`,
      })),
    }
  })
}
