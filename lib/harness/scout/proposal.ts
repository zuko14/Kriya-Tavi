import { createHash } from "node:crypto"

import { desc, eq, sql } from "drizzle-orm"
import { z } from "zod"

import { privileged } from "@/db"
import {
  harnessCartridgeCandidates,
  harnessScoutFindings,
  harnessScoutRuns,
  harnessScoutSources,
} from "@/db/schema"
import type { TaskResult } from "@/lib/harness/bench/run"
import { gate, type Verdict } from "@/lib/harness/evolve/gate"
import { setSetting } from "@/lib/config"
import { audit } from "@/lib/owner"

import { ReportCandidate, type CandidateFile } from "./candidate-file"
import { createVersion } from "./versions"

// Harness 2.0 W9: candidates from benchmark to the owner's decision
// (SELF_EVOLUTION §3–4). The bench runs on the owner's machine (WD-08); the
// owner uploads both arms' reports; code checks they belong to this
// candidate and agree with each other, gate() (reused as is) gives the
// verdict, and the status follows the verdict in SQL. No input carries a
// verdict or a status: the owner can approve or reject, nothing else, and a
// rejected candidate can't be approved by anyone (the transition table).

type Candidate = typeof harnessCartridgeCandidates.$inferSelect

export class ProposalError extends Error {}

/** The file the owner downloads to bench a candidate. */
export function candidateFile(c: Candidate): CandidateFile {
  return {
    kind: "kriya-cartridge-candidate",
    candidateId: c.id,
    cartridgeId: c.cartridgeId,
    baseVersion: c.baseVersion,
    body: c.body,
    judgement: c.judgement,
    sha256: c.bodySha256,
  }
}

const MAX_REPORT_CHARS = 2_000_000
const Result = z.looseObject({
  id: z.string().min(1).max(60),
  kind: z.string(),
  level: z.string(),
  status: z.enum(["passed", "failed", "invalid"]),
  escaped: z.boolean(),
  leaked: z.boolean(),
  tampered: z.boolean(),
  constraintBroken: z.boolean().optional(),
  agentTimedOut: z.boolean(),
  durationMs: z.number().int().min(0),
  // bigints are written as strings in report files
  costMicroInr: z.string().regex(/^\d+$/).nullable().optional(),
})
export const BenchReport = z.looseObject({
  seedVersion: z.string().regex(/^[a-f0-9]{12}$/),
  agent: z.string().max(500),
  results: z.array(Result).min(1).max(1000),
  profileId: z.string().max(100).optional(),
  cartridgeCandidate: ReportCandidate.optional(),
})

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const toJson = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)))

function parseReport(text: string) {
  if (text.length > MAX_REPORT_CHARS) throw new ProposalError("A report is too large.")
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ProposalError("A report isn't JSON.")
  }
  const parsed = BenchReport.safeParse(raw)
  if (!parsed.success) throw new ProposalError("A report isn't a KriyaBench report.")
  const report = parsed.data
  return {
    report,
    hash: sha256(text),
    gated: {
      seedVersion: report.seedVersion,
      results: report.results.map((r) => ({
        ...r,
        costMicroInr: typeof r.costMicroInr === "string" ? BigInt(r.costMicroInr) : null,
      })) as unknown as TaskResult[],
    },
  }
}

/**
 * Checks the paired reports against the candidate and each other and runs
 * gate(). Pure apart from the hashing. Run i of each arm is a pair.
 */
export function judgeEvidence(
  c: Pick<Candidate, "id" | "cartridgeId" | "bodySha256">,
  incumbentTexts: string[],
  candidateTexts: string[]
) {
  if (!incumbentTexts.length || incumbentTexts.length !== candidateTexts.length)
    throw new ProposalError(
      "Upload the same number of reports for each arm, at least one."
    )
  if (incumbentTexts.length > 10) throw new ProposalError("At most 10 runs per arm.")
  const inc = incumbentTexts.map(parseReport)
  const cand = candidateTexts.map(parseReport)
  const all = [...inc, ...cand]
  if (new Set(all.map((r) => r.hash)).size !== all.length)
    throw new ProposalError("The same report was uploaded twice.")
  for (const r of inc)
    if (r.report.cartridgeCandidate)
      throw new ProposalError("An incumbent report ran a candidate.")
  for (const r of cand) {
    const ran = r.report.cartridgeCandidate
    if (
      !ran ||
      ran.id !== c.id ||
      ran.cartridgeId !== c.cartridgeId ||
      ran.sha256 !== c.bodySha256
    )
      throw new ProposalError(
        "A candidate report didn't run this candidate's text (its hash doesn't match)."
      )
  }
  const seeds = new Set(all.map((r) => r.report.seedVersion))
  if (seeds.size !== 1) throw new ProposalError("The reports ran different seed sets.")
  const profiles = new Set(all.map((r) => r.report.profileId ?? null))
  if (profiles.size !== 1) throw new ProposalError("The reports ran different profiles.")
  const result = gate(
    inc.map((r) => r.gated),
    cand.map((r) => r.gated)
  )
  return {
    verdict: toJson(result) as { verdict: Verdict; reasons: string[]; metrics: unknown },
    evidence: {
      seedVersion: [...seeds][0],
      profileId: [...profiles][0],
      runs: inc.length,
      reports: [
        ...inc.map((r) => ({ arm: "incumbent", sha256: r.hash, agent: r.report.agent })),
        ...cand.map((r) => ({ arm: "candidate", sha256: r.hash, agent: r.report.agent })),
      ],
    },
  }
}

const NEXT: Record<Verdict, "proposed" | "held" | "rejected"> = {
  adopt: "proposed",
  canary: "proposed",
  hold: "held",
  reject: "rejected",
}

const transition = (
  tx: Pick<typeof privileged, "execute">,
  id: string,
  to: string,
  actor: string | null,
  reason: string | null,
  verdict: unknown = null,
  evidence: unknown = null
) =>
  tx.execute(
    sql`select kriya.harness_candidate_transition(${id}::uuid, ${to}, ${actor}::uuid, ${reason}, ${verdict === null ? null : JSON.stringify(verdict)}::jsonb, ${evidence === null ? null : JSON.stringify(evidence)}::jsonb)`
  )

export async function getCandidate(id: string) {
  const [c] = await privileged
    .select()
    .from(harnessCartridgeCandidates)
    .where(eq(harnessCartridgeCandidates.id, id))
  return c ?? null
}

/** The owner's uploaded reports: judged by code, then benched and moved by the verdict. */
export async function benchCandidate(
  id: string,
  incumbentTexts: string[],
  candidateTexts: string[],
  actorId: string
) {
  const c = await getCandidate(id)
  if (!c) throw new ProposalError("No such candidate.")
  if (c.status !== "awaiting_bench")
    throw new ProposalError("This candidate isn't waiting for a benchmark.")
  const { verdict, evidence } = judgeEvidence(c, incumbentTexts, candidateTexts)
  await privileged.transaction(async (tx) => {
    await transition(tx, id, "benched", actorId, null, verdict, evidence)
    await transition(tx, id, NEXT[verdict.verdict], actorId, null)
  })
  return verdict
}

/** Approve (a held one needs a typed reason) or reject; the SQL edges decide what's allowed. */
export async function decideCandidate(
  id: string,
  decision: "approve" | "reject",
  actorId: string,
  reason?: string
) {
  const c = await getCandidate(id)
  if (!c) throw new ProposalError("No such candidate.")
  if (c.status !== "proposed" && c.status !== "held")
    throw new ProposalError(
      c.status === "rejected"
        ? "A rejected candidate can't be approved."
        : "This candidate isn't waiting for a decision."
    )
  const why = reason?.trim() || null
  if (decision === "approve" && c.status === "held" && (why?.length ?? 0) < 10)
    throw new ProposalError(
      "Approving a held candidate needs a reason (10 characters or more)."
    )
  // W11: an approval stores the version in the same transaction (served only with the overlay on)
  await privileged.transaction(async (tx) => {
    await transition(
      tx,
      id,
      decision === "approve" ? "approved" : "rejected",
      actorId,
      why
    )
    if (decision === "approve") await createVersion(tx, id)
  })
}

/** Turns the Scout off and stops its running run; one audit record. */
export async function freezeScout(actorId: string) {
  await setSetting("harness.scout", "off", actorId)
  await privileged
    .update(harnessScoutRuns)
    .set({ status: "frozen", finishedAt: new Date() })
    .where(eq(harnessScoutRuns.status, "running"))
  await audit(actorId, "harness.scout.freeze")
}

/** The owner page's list, newest first, with each candidate's findings and their sources. */
export async function candidateOverview() {
  const candidates = await privileged
    .select()
    .from(harnessCartridgeCandidates)
    .orderBy(desc(harnessCartridgeCandidates.createdAt))
    .limit(50)
  const ids = [...new Set(candidates.flatMap((c) => c.findingIds))]
  const findings = ids.length
    ? await privileged
        .select({
          id: harnessScoutFindings.id,
          claim: harnessScoutFindings.claim,
          quote: harnessScoutFindings.quote,
          kind: harnessScoutFindings.kind,
          corroborated: harnessScoutFindings.corroborated,
          firstSeenAt: harnessScoutFindings.firstSeenAt,
          confirmedAt: harnessScoutFindings.confirmedAt,
          url: harnessScoutSources.url,
        })
        .from(harnessScoutFindings)
        .innerJoin(
          harnessScoutSources,
          eq(harnessScoutSources.id, harnessScoutFindings.sourceId)
        )
        .where(sql`${harnessScoutFindings.id} = any(${ids}::uuid[])`)
    : []
  const byId = new Map(findings.map((f) => [f.id, f]))
  return candidates.map((c) => ({
    ...c,
    findings: c.findingIds.flatMap((f) => (byId.has(f) ? [byId.get(f)!] : [])),
  }))
}
