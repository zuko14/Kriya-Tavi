import type { RunProof } from "@/lib/harness/contract"
import { cn } from "@/lib/utils"

// S-3 (docs/kriya-harness/TASK_PROOF.md): what a computer reports about a task
// Kriya started, as it parsed in lib/harness/control.ts. The verdict is
// computed by code on that computer, never by a model, and is labelled as
// reported by it. Changes are names and line counts; the code stays there.

const VERDICT: Record<
  NonNullable<RunProof["verdict"]>,
  { label: string; tone: string }
> = {
  verified: {
    label: "Verified by its checks",
    tone: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
  partial: { label: "Partly verified", tone: "bg-betelgeuse/15 text-betelgeuse" },
  failed: { label: "Checks failed", tone: "bg-destructive/12 text-destructive" },
  blocked: { label: "Blocked", tone: "bg-destructive/12 text-destructive" },
  "not checked": { label: "Not checked", tone: "bg-muted text-muted-foreground" },
}
const STEP_MARK: Record<string, { mark: string; tone: string; label: string }> = {
  pass: { mark: "✓", tone: "text-emerald-600 dark:text-emerald-400", label: "passed" },
  fail: { mark: "✗", tone: "text-destructive", label: "failed so far" },
  blocked: { mark: "■", tone: "text-destructive", label: "blocked" },
  "not run": { mark: "·", tone: "text-muted-foreground", label: "not run yet" },
}
const RETRYING = { mark: "↻", tone: "text-rigel", label: "trying again" }
const FILE_MARK = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const
const LEVEL = { head: "Head", worker: "Worker", single: "" } as const

type Step = NonNullable<RunProof["steps"]>[number]

/** "Worker · DeepSeek V4.1 Flash ×2, then Head · gemini-4-neon" */
function builders(step: Step) {
  const runs: { who: string; local: boolean; times: number }[] = []
  for (const b of step.builtBy) {
    const who = [LEVEL[b.level], b.name].filter(Boolean).join(" · ")
    const last = runs.at(-1)
    if (last?.who === who) last.times++
    else runs.push({ who, local: !!b.local, times: 1 })
  }
  return runs
}

export function ProofCard({ proof, running }: { proof: RunProof; running: boolean }) {
  const verdict = proof.verdict ? VERDICT[proof.verdict] : null
  const changes = proof.changes
  return (
    <section
      aria-label="Proof from your computer"
      className="mt-2 flex flex-col gap-2.5 rounded-2xl border bg-surface/60 px-3 py-3"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-mono">Checked on your computer</span>
        {verdict ? (
          // While it runs, a failed try isn't the outcome yet: neutral, not red
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[12px] font-medium",
              running ? "bg-rigel/10 text-rigel" : verdict.tone
            )}
          >
            {running ? "Checking…" : verdict.label}
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground">
            {running ? "Checking…" : "No plan was run, so nothing was checked by code"}
          </span>
        )}
      </header>

      {proof.touchedChecks?.length ? (
        <p className="text-[12.5px] leading-relaxed text-betelgeuse">
          The task changed test or check files: {proof.touchedChecks.join(", ")}. Review
          them before trusting the result.
        </p>
      ) : null}

      {proof.steps?.length ? (
        <ol className="flex flex-col gap-2">
          {proof.steps.map((step) => {
            // A failed try with tries left, while the task runs, is being tried again
            const mark =
              running && step.verdict === "fail"
                ? RETRYING
                : (STEP_MARK[step.verdict] ?? STEP_MARK["not run"])
            const by = builders(step)
            return (
              <li key={step.n} className="flex items-start gap-2 text-[12.5px]">
                <span
                  className={cn("mt-0.5 w-3 shrink-0 font-mono", mark.tone)}
                  aria-hidden
                >
                  {mark.mark}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span>
                    <span className="font-medium">
                      {step.n}. {step.title}
                    </span>
                    <span className="sr-only"> ({mark.label})</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {step.attempts} {step.attempts === 1 ? "try" : "tries"}
                    </span>
                  </span>
                  {by.length > 0 && (
                    <span className="text-muted-foreground">
                      Built by{" "}
                      {by.map((b, i) => (
                        <span key={i}>
                          {i > 0 && ", then "}
                          {b.who}
                          {b.times > 1 && ` ×${b.times}`}
                          {b.local && (
                            <span className="ml-1 rounded bg-rigel/10 px-1 text-[11px] text-rigel">
                              on your computer
                            </span>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                  {step.gates.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {step.gates.map((g) => (
                        <span
                          key={g.id}
                          className={cn(
                            "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                            g.status === "pass"
                              ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                              : g.status === "fail"
                                ? "border-destructive/40 text-destructive"
                                : "text-muted-foreground"
                          )}
                        >
                          {g.id} {g.status}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      ) : null}

      {changes && (
        <details className="text-[12.5px]">
          <summary className="flex min-h-11 cursor-pointer items-center gap-1 sm:min-h-8">
            {changes.count === 0 ? (
              "No files changed"
            ) : (
              <>
                {changes.count} {changes.count === 1 ? "file" : "files"} changed
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{changes.added}
                </span>
                <span className="text-destructive">−{changes.deleted}</span>
              </>
            )}
          </summary>
          {changes.files.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1 font-mono text-[11.5px]">
              {changes.files.map((f) => (
                <li key={f.path} className="flex min-w-0 items-center gap-2">
                  <span className="w-3 shrink-0 text-muted-foreground" title={f.status}>
                    {FILE_MARK[f.status]}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={f.path}>
                    {f.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {f.binary ? "binary" : `+${f.added ?? 0} −${f.deleted ?? 0}`}
                  </span>
                </li>
              ))}
              {changes.count > changes.files.length && (
                <li className="text-muted-foreground">
                  and {changes.count - changes.files.length} more
                </li>
              )}
            </ul>
          )}
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            Names and line counts only. The code stays on your computer; open the session
            there to review the diff.
          </p>
        </details>
      )}
    </section>
  )
}
