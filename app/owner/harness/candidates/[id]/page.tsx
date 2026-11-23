import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import {
  BenchUpload,
  CandidateDownload,
  DecideCandidate,
} from "@/components/owner/harness-evolve/forms"
import { Section, Table, Td } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import type { LintResult } from "@/lib/harness/scout/lint"
import {
  candidateFile,
  candidateOverview,
  getCandidate,
} from "@/lib/harness/scout/proposal"

export const metadata: Metadata = { title: "Cartridge proposal" }

// Harness 2.0 W9: SKILL_UPDATE_PROPOSAL as a page (SELF_EVOLUTION §4).
// Everything here is read from the stored candidate: the verdict is gate()'s,
// computed when the reports were uploaded; the page only shows it.

const WHEN = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})
const when = (d: Date | null) => (d ? WHEN.format(d) : "—")

type Arm = {
  runs: number
  attempts: number
  passed: number
  passPerMille: number
  passCiPerMille: [number, number] | null
  costPerPassedMicroInr: string | null
  medianDurationMs: number | null
  safety: Record<string, number>
}
type Verdict = {
  verdict: string
  reasons: string[]
  metrics: {
    runs: number
    pairs: number
    onlyIncumbent: number
    onlyCandidate: number
    p: number
    costChangePerMille: number | null
    incumbent: Arm
    candidate: Arm
  }
}
type Evidence = {
  seedVersion: string
  profileId: string | null
  runs: number
  reports: { arm: string; sha256: string; agent: string }[]
}

const pct = (perMille: number) => `${perMille / 10}%`
const ci = (c: [number, number] | null) => (c ? `${pct(c[0])}–${pct(c[1])}` : "—")
const inr = (micro: string | null) =>
  micro === null ? "unknown" : `₹${(Number(BigInt(micro)) / 1_000_000).toFixed(2)}`
const SAFETY = [
  "escaped",
  "leaked",
  "constraintBroken",
  "tampered",
  "invalid",
  "timedOut",
]

export default async function CandidatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireOwner()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) notFound()
  const c = await getCandidate(id.data)
  if (!c) notFound()
  const findings = (await candidateOverview()).find((x) => x.id === c.id)?.findings ?? []
  const lint = c.lint as LintResult
  const verdict = c.verdict as Verdict | null
  const evidence = c.evidence as Evidence | null
  const corroborated = findings.some((f) => f.corroborated)

  return (
    <>
      <header className="flex flex-col gap-2">
        <Link href="/owner/harness" className="text-[13px] text-rigel hover:underline">
          ← Harness evolve
        </Link>
        <h1 className="font-display text-[28px] leading-tight font-normal break-all sm:text-[34px]">
          {c.cartridgeId} from {c.baseVersion}
        </h1>
        <p className="font-mono text-[11.5px] text-muted-foreground">{c.id}</p>
      </header>

      <Section title="Summary">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">Discipline</dt>
          <dd>{c.cartridgeId.replace("kriya-role-", "")}</dd>
          <dt className="text-muted-foreground">Kind</dt>
          <dd>{findings.map((f) => f.kind.replace("_", " ")).join(", ") || "—"}</dd>
          <dt className="text-muted-foreground">Claim</dt>
          <dd>{findings.map((f) => f.claim).join(" · ") || "—"}</dd>
          <dt className="text-muted-foreground">Sources</dt>
          <dd>{corroborated ? "corroborated" : "single source"}</dd>
          <dt className="text-muted-foreground">State</dt>
          <dd>
            <strong>{c.status.replace("_", " ")}</strong>
            {c.decidedAt && ` · decided ${when(c.decidedAt)}`}
            {c.reason && ` · “${c.reason}”`}
          </dd>
        </dl>
      </Section>

      <Section
        title="Sources"
        description="Each quote was found word for word in the page, and again at least an hour later."
      >
        {findings.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No finding recorded.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-[13px]">
            {findings.map((f) => (
              <li key={f.id} className="flex flex-col gap-1">
                <blockquote className="border-l-2 pl-3">
                  &ldquo;{f.quote}&rdquo;
                </blockquote>
                <span className="text-[12px] text-muted-foreground">
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-all text-rigel hover:underline"
                  >
                    {f.url}
                  </a>{" "}
                  · read {when(f.firstSeenAt)} · again {when(f.confirmedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Diff" description="Line by line against the incumbent body.">
        <pre className="glass overflow-x-auto rounded-[18px] p-4 font-mono text-[12px] leading-relaxed">
          {c.diff.split("\n").map((line, i) => (
            <span
              key={i}
              className={
                line.startsWith("+")
                  ? "block bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : line.startsWith("-")
                    ? "block bg-red-500/10 text-red-700 line-through decoration-red-500/40 dark:text-red-300"
                    : "block text-muted-foreground"
              }
            >
              {line || " "}
            </span>
          ))}
        </pre>
        {(c.addedGates.length > 0 ||
          c.addedDetectors.length > 0 ||
          c.addedKeywords.length > 0) && (
          <p className="text-[13px]">
            Added:{" "}
            {[...c.addedGates, ...c.addedDetectors].join(", ") || "no gate or detector"}
            {c.addedKeywords.length > 0 && `; keywords ${c.addedKeywords.join(", ")}`}
          </p>
        )}
      </Section>

      <Section
        title="Lint"
        description={`${lint.changedLines} of ${lint.baseLines} lines changed.`}
      >
        <ul className="flex flex-col gap-1 text-[13px]">
          {lint.rules.map((r) => (
            <li key={r.rule}>
              <span aria-hidden="true">{r.ok ? "✓" : "✗"}</span>{" "}
              <span className="sr-only">{r.ok ? "Passed:" : "Failed:"}</span>
              {r.rule}. {r.label}
              {!r.ok && (
                <span className="block pl-5 text-destructive">
                  {r.problems.join("; ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Benchmark"
        description="Run on your own machine (WD-08), never on Kriya's servers."
      >
        {verdict && evidence ? (
          <>
            <Table head={["", "incumbent", "candidate"]}>
              {(
                [
                  [
                    "pass",
                    (a: Arm) => `${a.passed}/${a.attempts} (${pct(a.passPerMille)})`,
                  ],
                  ["Wilson 95%", (a: Arm) => ci(a.passCiPerMille)],
                  ["cost per pass", (a: Arm) => inr(a.costPerPassedMicroInr)],
                  [
                    "median duration",
                    (a: Arm) =>
                      a.medianDurationMs === null
                        ? "—"
                        : `${Math.round(a.medianDurationMs / 1000)} s`,
                  ],
                  ...SAFETY.map(
                    (k) => [k, (a: Arm) => String(a.safety[k] ?? 0)] as const
                  ),
                ] as const
              ).map(([label, f]) => (
                <tr key={label}>
                  <Td>{label}</Td>
                  <Td>{f(verdict.metrics.incumbent)}</Td>
                  <Td>{f(verdict.metrics.candidate)}</Td>
                </tr>
              ))}
            </Table>
            <p className="text-[13px]">
              Pairs {verdict.metrics.pairs}: only incumbent{" "}
              {verdict.metrics.onlyIncumbent}, only candidate{" "}
              {verdict.metrics.onlyCandidate} (b/c), p = {verdict.metrics.p.toFixed(3)}; Δ
              cost per pass{" "}
              {verdict.metrics.costChangePerMille === null
                ? "unknown"
                : `${verdict.metrics.costChangePerMille / 10}%`}
              ; {evidence.runs} run(s) per arm; seed {evidence.seedVersion}; profile{" "}
              {evidence.profileId ?? "none"}.
            </p>
            <p className="font-mono text-[11px] break-all text-muted-foreground">
              {evidence.reports
                .map((r) => `${r.arm} ${r.sha256.slice(0, 16)}`)
                .join(" · ")}
            </p>
          </>
        ) : c.status === "awaiting_bench" ? (
          <div className="flex flex-col gap-3 text-[13px]">
            <p>
              Download the candidate, run each arm K = 3 times on your machine,
              alternating, with the same model and seed set:
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-[11.5px]">
              {`npx tsx lib/harness/bench/cli.ts --agent "kriya run --mode auto" --level role-${c.cartridgeId.replace("kriya-role-", "")} --meter "kriya usage --json" --out inc-1.json\nnpx tsx lib/harness/bench/cli.ts --agent "kriya run --mode auto" --level role-${c.cartridgeId.replace("kriya-role-", "")} --meter "kriya usage --json" --cartridge-candidate ./candidate-${c.id}.json --out cand-1.json`}
            </pre>
            <CandidateDownload file={candidateFile(c)} name={`candidate-${c.id}.json`} />
            <BenchUpload id={c.id} />
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Not benched (lint refused it).
          </p>
        )}
      </Section>

      <Section
        title="Verdict"
        description="Computed by gate() from the reports, never typed."
      >
        {verdict ? (
          <div className="flex flex-col gap-1 text-[13px]">
            <p>
              <strong>{verdict.verdict}</strong>
            </p>
            <ul className="list-disc pl-5">
              {verdict.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">No verdict yet.</p>
        )}
      </Section>

      {(c.status === "proposed" || c.status === "held") && (
        <Section
          title="Decision"
          description="Approval stores your decision. Nothing is served to devices: with the overlay off, ship the diff in a reviewed commit."
        >
          <DecideCandidate id={c.id} held={c.status === "held"} />
        </Section>
      )}
    </>
  )
}
