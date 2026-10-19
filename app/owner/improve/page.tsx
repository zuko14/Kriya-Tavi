import type { Metadata } from "next"

import { VersionControls } from "@/components/owner/improve-controls"
import { Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import type { PolicyVersion } from "@/db/schema"
import { requireOwner } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import {
  BASELINE,
  bundleSchema,
  CANARY_STEPS,
  listVersions,
  MIN_CANARY_TASKS,
  versionMetrics,
  type GateReport,
} from "@/lib/improve"

export const metadata: Metadata = { title: "Improvement" }

// Governed improvement (A12, AD-25): policy versions with their offline gate
// and shadow results, the canary's live numbers, and the owner's promotion
// and rollback. Safety rules, risk classes and limits are never in a bundle.

const WHEN = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})

// What a bundle changes against the code baseline, in one line
function changes(bundle: unknown) {
  const parsed = bundleSchema.safeParse(bundle)
  if (!parsed.success) return "invalid bundle"
  const out: string[] = []
  if (parsed.data.prompts.saveGuidance !== BASELINE.prompts.saveGuidance) {
    out.push("save-guidance wording")
  }
  for (const group of ["retrieval", "budgets"] as const) {
    const now = parsed.data[group] as Record<string, number>
    const was = BASELINE[group] as Record<string, number>
    for (const key of Object.keys(now)) {
      if (now[key] !== was[key]) out.push(`${key} ${was[key]} → ${now[key]}`)
    }
  }
  return out.length > 0 ? out.join(" · ") : "same as baseline"
}

function nextStep(row: PolicyVersion) {
  const report = (row.evalReport ?? {}) as {
    gate?: GateReport
    shadow?: { pass: boolean }
  }
  if (row.status === "shadow") {
    return report.gate?.pass && report.shadow?.pass
      ? `Start canary (${CANARY_STEPS[0]} %)`
      : null
  }
  if (row.status !== "canary") return null
  const next = CANARY_STEPS.find((step) => step > row.canaryPercent)!
  return next < 100 ? `Widen to ${next} %` : "Make active"
}

function results(row: PolicyVersion) {
  const report = (row.evalReport ?? {}) as {
    gate?: GateReport
    shadow?: { n: number; agreement: number; pass: boolean }
  }
  const gate = report.gate
    ? report.gate.pass
      ? `gate passed (n ${report.gate.n})`
      : `gate failed: ${report.gate.reasons.join("; ")}`
    : "no gate yet"
  const shadow = report.shadow
    ? `shadow ${(report.shadow.agreement * 100).toFixed(1)} % (n ${report.shadow.n})`
    : "no shadow yet"
  return `${gate} · ${shadow}`
}

export default async function OwnerImprove() {
  await requireOwner()
  const [on, versions] = await Promise.all([
    getSetting("agents.improvement"),
    listVersions(),
  ])
  const active = versions.find((v) => v.status === "active")
  const canary = versions.find((v) => v.status === "canary")
  const [activeLive, canaryLive] = await Promise.all([
    versionMetrics(active?.id ?? "baseline"),
    canary ? versionMetrics(canary.id) : null,
  ])
  const pct = (value: number) => `${(value * 100).toFixed(1)} %`

  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Improvement
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Versions of the tunable behaviour (prompt wording, recall weights, token
          budgets). Each passes an offline gate and a shadow run before a canary; the
          worker rolls a canary back when its failure rate or cost worsens. Safety rules,
          risk classes and limits are never part of a version.
        </p>
      </header>

      <Tiles>
        <Tile
          label="agents.improvement"
          value={on}
          hint={on === "on" ? "tasks use these versions" : "every task uses the baseline"}
          tone={on === "on" ? "good" : "warn"}
        />
        <Tile
          label="in charge"
          value={active ? active.id : "baseline"}
          hint={`${activeLive.n} tasks · ${pct(activeLive.failedRate)} failed (7 days)`}
        />
        <Tile
          label="canary"
          value={canary ? `${canary.canaryPercent} %` : "none"}
          hint={
            canary && canaryLive
              ? `${canaryLive.n}/${MIN_CANARY_TASKS} tasks · ${pct(canaryLive.failedRate)} failed`
              : "nothing being tried"
          }
          tone={canary ? "warn" : undefined}
        />
        <Tile
          label="cost per task"
          value={`${Math.round(canaryLive?.costPerTask ?? activeLive.costPerTask)} µ$`}
          hint={
            canary ? `active ${Math.round(activeLive.costPerTask)} µ$` : "active version"
          }
        />
      </Tiles>

      <Section title={`${versions.length} version(s)`}>
        {versions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No versions yet. The code baseline runs until a version is proposed and passes
            its gate.
          </p>
        ) : (
          <Table
            head={["version", "status", "changes", "results", "proposed", "actions"]}
          >
            {versions.map((v) => (
              <tr key={v.id}>
                <Td className="font-mono text-[11.5px]">
                  {v.id}
                  <br />
                  <span className="text-muted-foreground">
                    {v.bundleHash.slice(0, 12)}
                  </span>
                </Td>
                <Td>
                  {v.status}
                  {v.status === "canary" && ` ${v.canaryPercent} %`}
                </Td>
                <Td>{changes(v.bundle)}</Td>
                <Td className="text-[12px]">{results(v)}</Td>
                <Td className="font-mono text-[11.5px]">
                  {v.proposedBy} · {WHEN.format(v.createdAt)}
                </Td>
                <Td>
                  <VersionControls
                    id={v.id}
                    next={nextStep(v)}
                    canRollBack={v.status === "canary" || v.status === "active"}
                  />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  )
}
