import { and, asc, eq, inArray, isNull } from "drizzle-orm"

import { privileged, type Q } from "@/db"
import {
  callOutcomes,
  episodes,
  files,
  goals,
  invoices,
  ledgerEntries,
  mandates,
  voiceTasks,
  type Criterion,
  type CriterionResult,
  type EpisodeAction,
  type Mandate,
  type MandateStatus,
} from "@/db/schema"
import { crewThreadIds } from "@/lib/operator/crew-threads"
import { STATUS_LABEL } from "@/lib/operator/labels"

// Whether a job is done (track O, O5; OD-05/06): computed by code from rows,
// never from what a model wrote. `verdict` is pure; `loadEvidence` reads
// the rows, with the person's id in every query (invariant 1).

export type Evidence = {
  // "What I did" records of the job's goal thread and its crews' part
  // threads (O11), not deleted
  episodes: { id: string; done: EpisodeAction[]; files: string[] }[]
  calls: { voiceTaskId: string; result: string | null; verifier: string }[]
  invoices: { id: string; status: string }[]
  ledger: { id: string; status: string }[]
  // The job's own report PDFs (OF-19: they count as a file it made)
  reports?: string[]
  // Criterion ids the person ticked
  confirmed: string[]
}

type Subjects = Mandate["subjects"]

// Every listed row present and in `status`; an empty list is never proof
function allListed(
  ids: string[] | undefined,
  rows: { id: string; status: string }[],
  status: string,
  kind: "invoice" | "ledger"
) {
  const listed = ids ?? []
  const met =
    listed.length > 0 &&
    listed.every((id) => rows.some((row) => row.id === id && row.status === status))
  return { met, refs: met ? listed.map((id) => ({ kind, id })) : [] }
}

function check(criterion: Criterion, subjects: Subjects, evidence: Evidence) {
  const spec = criterion.evidence
  switch (spec.kind) {
    case "tool_verified": {
      const runs = evidence.episodes.flatMap((e) =>
        e.done
          .filter((d) => d.tool === spec.tool && d.verification.status === "verified")
          .map(() => e.id)
      )
      const met = runs.length >= (spec.atLeast ?? 1)
      return {
        met,
        refs: met
          ? [...new Set(runs)].map((id) => ({ kind: "episode" as const, id }))
          : [],
      }
    }
    case "call_outcome": {
      const calls = evidence.calls.filter(
        (call) =>
          call.verifier === "accepted" &&
          (spec.results as string[]).includes(call.result ?? "")
      )
      return {
        met: calls.length > 0,
        refs: calls.map((call) => ({
          kind: "voice_task" as const,
          id: call.voiceTaskId,
        })),
      }
    }
    case "invoice_paid":
      return allListed(subjects.invoices, evidence.invoices, "paid", "invoice")
    case "ledger_confirmed":
      return allListed(subjects.ledger, evidence.ledger, "confirmed", "ledger")
    case "file_created": {
      const files = [
        ...evidence.episodes.flatMap((e) => e.files),
        ...(evidence.reports ?? []),
      ]
      return {
        met: files.length > 0,
        refs: files.map((id) => ({ kind: "file" as const, id })),
      }
    }
    case "person_confirmed":
      return { met: evidence.confirmed.includes(criterion.id), refs: [] }
  }
}

export function verdict(
  criteria: Criterion[],
  subjects: Subjects,
  evidence: Evidence
): CriterionResult[] {
  return criteria.map((criterion) => {
    const { met, refs } = check(criterion, subjects, evidence)
    const by = !met
      ? null
      : criterion.evidence.kind === "person_confirmed"
        ? ("person" as const)
        : ("evidence" as const)
    return { id: criterion.id, met, refs, by }
  })
}

export const allMet = (results: CriterionResult[]) =>
  results.length > 0 && results.every((r) => r.met)

// The rows a verdict reads. `q` is the worker's privileged handle or the
// person's own transaction; either way every query names the person.
export async function loadEvidence(
  q: Q,
  userId: string,
  job: Pick<Mandate, "id" | "goalId" | "subjects" | "confirmed">
): Promise<Evidence> {
  const [goal] = job.goalId
    ? await q
        .select({ threadId: goals.threadId })
        .from(goals)
        .where(and(eq(goals.id, job.goalId), eq(goals.userId, userId)))
    : []
  const threadIds = goal
    ? [goal.threadId, ...(await crewThreadIds(q, userId, job.id))]
    : []
  const invoiceIds = job.subjects.invoices ?? []
  const ledgerIds = job.subjects.ledger ?? []
  return {
    episodes: goal
      ? await q
          .select({ id: episodes.id, done: episodes.done, files: episodes.files })
          .from(episodes)
          .where(
            and(
              eq(episodes.userId, userId),
              inArray(episodes.threadId, threadIds),
              isNull(episodes.deletedAt)
            )
          )
          .orderBy(asc(episodes.createdAt))
      : [],
    calls: goal
      ? await q
          .select({
            voiceTaskId: voiceTasks.id,
            result: voiceTasks.result,
            verifier: callOutcomes.verifierStatus,
          })
          .from(voiceTasks)
          .innerJoin(
            callOutcomes,
            and(
              eq(callOutcomes.voiceTaskId, voiceTasks.id),
              eq(callOutcomes.userId, userId)
            )
          )
          .where(
            and(eq(voiceTasks.userId, userId), inArray(voiceTasks.threadId, threadIds))
          )
      : [],
    invoices: invoiceIds.length
      ? await q
          .select({ id: invoices.id, status: invoices.status })
          .from(invoices)
          .where(and(eq(invoices.userId, userId), inArray(invoices.id, invoiceIds)))
      : [],
    ledger: ledgerIds.length
      ? await q
          .select({ id: ledgerEntries.id, status: ledgerEntries.status })
          .from(ledgerEntries)
          .where(
            and(eq(ledgerEntries.userId, userId), inArray(ledgerEntries.id, ledgerIds))
          )
      : [],
    // Saved by jobReportPdf (lib/share.ts); only the server makes generated files
    reports: (
      await q
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.userId, userId),
            eq(files.origin, "generated"),
            eq(files.status, "ready"),
            eq(files.name, `kriya-job-${job.id}.pdf`)
          )
        )
        .orderBy(asc(files.createdAt))
    ).map((f) => f.id),
    confirmed: job.confirmed,
  }
}

// What is proven so far, in a fixed order (rows come back in any order);
// no verdict yet and nothing met are the same
const proofOf = (results: CriterionResult[] | null) =>
  JSON.stringify(
    (results ?? [])
      .filter((r) => r.met)
      .map((r) => [r.id, r.refs.map((ref) => `${ref.kind}:${ref.id}`).sort()])
      .sort()
  )

// Computes and stores a job's verdict; never its status (only the worker's
// review pass completes a job, O6). `last_evidence_at` moves when the proof
// changed, which the stuck rule reads.
export async function storeVerdict(q: Q, userId: string, job: Mandate, now = new Date()) {
  const results = verdict(job.criteria, job.subjects, await loadEvidence(q, userId, job))
  const changed = proofOf(results) !== proofOf(job.verdict)
  await q
    .update(mandates)
    .set({ verdict: results, ...(changed && { lastEvidenceAt: now }) })
    .where(and(eq(mandates.id, job.id), eq(mandates.userId, userId)))
  return { results, changed }
}

// For mandate_report: the job by id, or the job whose goal thread this is
export async function reportVerdict(
  userId: string,
  threadId: string,
  mandateId?: string
) {
  const [row] = mandateId
    ? await privileged
        .select({ job: mandates })
        .from(mandates)
        .where(and(eq(mandates.id, mandateId), eq(mandates.userId, userId)))
    : await privileged
        .select({ job: mandates })
        .from(mandates)
        .innerJoin(goals, eq(goals.id, mandates.goalId))
        .where(and(eq(mandates.userId, userId), eq(goals.threadId, threadId)))
  if (!row) return { error: "No job found here. Give its id." }
  const { results } = await storeVerdict(privileged, userId, row.job)
  return {
    mandateId: row.job.id,
    verdict: results,
    allMet: allMet(results),
    note: "Computed by Kriya from what was verifiably done. Only Kriya's review marks a job done; say what's still unmet.",
  }
}

/* ───────────────────────────── report ───────────────────────────── */

// As the report template prints its own date: "5 Nov 2026"
const DAY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
})

const RESULT = (r: CriterionResult | undefined) =>
  !r?.met ? "Not confirmed" : r.by === "person" ? "Confirmed by you" : "Verified"

function proof(r: CriterionResult | undefined) {
  if (!r?.met || r.refs.length === 0) return "—"
  const counts = new Map<string, number>()
  for (const ref of r.refs) counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1)
  const NAMES: Record<string, [string, string]> = {
    episode: ["record", "records"],
    voice_task: ["checked call", "checked calls"],
    invoice: ["paid invoice", "paid invoices"],
    ledger: ["confirmed entry", "confirmed entries"],
    file: ["file", "files"],
  }
  return [...counts].map(([kind, n]) => `${n} ${NAMES[kind][n === 1 ? 0 : 1]}`).join(", ")
}

// One line for the job panel: "Verified · 2 records", "Not confirmed"
export function describeResult(r: CriterionResult | undefined) {
  const shown = proof(r)
  return shown === "—" ? RESULT(r) : `${RESULT(r)} · ${shown}`
}

// The handover report as data for the existing `report` template (no new
// template): every line with its result and proof
export function reportData(
  job: Pick<Mandate, "title" | "objective" | "dueAt" | "criteria"> & {
    status: MandateStatus
  },
  results: CriterionResult[],
  now = new Date()
) {
  const met = results.filter((r) => r.met).length
  return {
    title: job.title.slice(0, 200),
    subtitle: `Job report · ${STATUS_LABEL[job.status]}`,
    date: now.toISOString().slice(0, 10),
    sections: [
      {
        heading: "Done means",
        paragraphs: [
          `${met} of ${job.criteria.length} lines met. Checked by Kriya from its records; "Not confirmed" means no record proves it yet.`,
        ],
        table: {
          columns: ["Line", "Result", "Proof"],
          rows: job.criteria.map((c) => {
            const r = results.find((x) => x.id === c.id)
            return [c.text, RESULT(r), proof(r)]
          }),
        },
      },
      {
        heading: "The job",
        paragraphs: [job.objective, `Due ${DAY.format(job.dueAt)}.`],
      },
    ],
  }
}
