import type { Metadata } from "next"

import { Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { formatInr } from "@/lib/money"
import { operatorMetrics, type OperatorMetrics } from "@/lib/operator/metrics"

export const metadata: Metadata = { title: "Operator" }

// Operator metrics (track O, O8; TEST_AND_EVALUATION §2): OM1–OM8 for 7 and
// 30 days, jobs by status, grants by tool, and the kill list. Read-only;
// switches and the kill list are edited in Config. Counts are shown as
// "x of n", never rounded; nothing a person wrote appears here.

const of = (x: number, n: number) => (n === 0 ? "no data" : `${x} of ${n}`)
const secs = (value: number | null) => (value === null ? "—" : `${value} s`)

function Window({ m }: { m: OperatorMetrics }) {
  const priced = m.om6.finalMicroInr + m.om6.estimatedMicroInr
  return (
    <Tiles>
      <Tile
        label="OM1 jobs done"
        value={of(m.om1.completed, m.om1.ended)}
        hint="of jobs that ended"
      />
      <Tile
        label="OM2 unconfirmed claims"
        value={of(m.om2.unconfirmed, m.om2.records)}
        hint="of job records"
      />
      <Tile
        label="OM3 outside pins"
        value={of(m.om3.outsidePins, m.om3.granted)}
        tone={m.om3.outsidePins > 0 ? "bad" : m.om3.granted ? "good" : undefined}
        hint={`target 0 · unchecked ${m.om3.failedChecks}`}
      />
      <Tile
        label="OM4 approval wait"
        value={`${secs(m.om4.p50Seconds)} / ${secs(m.om4.p95Seconds)}`}
        hint={`p50 / p95 · n = ${m.om4.n}`}
      />
      <Tile label="OM5 approvals per job" value={of(m.om5.approvals, m.om5.jobs)} />
      <Tile
        label="OM6 cost of done jobs"
        // Never ₹0 for runs that have no price yet (invariant 6)
        value={
          m.om6.completed === 0
            ? "no data"
            : priced === 0 && m.om6.unpricedRuns > 0
              ? "not priced"
              : formatInr(priced)
        }
        hint={`${m.om6.completed} done · ${m.om6.unpricedRuns} unpriced runs`}
      />
      <Tile
        label="OM7 duplicates"
        value={m.om7.duplicates}
        tone={m.om7.duplicates > 0 ? "bad" : "good"}
        hint="target 0"
      />
      <Tile
        label="OM8 needing you now"
        value={of(m.om8.needsPerson, m.om8.open)}
        hint="of open jobs (current state)"
      />
    </Tiles>
  )
}

export default async function OwnerOperator() {
  await requireOwner()
  const [week, month, killList, mandates, grantsOn] = await Promise.all([
    operatorMetrics(7),
    operatorMetrics(30),
    getSetting("operator.disabledTools"),
    getSetting("operator.mandates"),
    getSetting("operator.grants"),
  ])

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Operator
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Jobs and standing grants across everyone, as counts. Jobs are{" "}
          {mandates === "on" ? "on" : "off"}; grants are{" "}
          {grantsOn === "on" ? "on" : "off"}. Change switches in Config.
        </p>
      </header>

      <Section title="Last 7 days">
        <Window m={week} />
      </Section>
      <Section title="Last 30 days">
        <Window m={month} />
      </Section>

      <Section title="Jobs by status" description="All time.">
        <Table head={["status", "jobs"]}>
          {Object.keys(month.statuses).length === 0 && (
            <Empty colSpan={2}>No jobs yet.</Empty>
          )}
          {Object.entries(month.statuses).map(([status, n]) => (
            <tr key={status}>
              <Td className="font-mono text-[12px]">{status}</Td>
              <Td className="tabular-nums">{n}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Grants by tool"
        description="All time: grants made, uses spent, uses allowed."
      >
        <Table head={["tool", "grants", "uses", "allowed"]}>
          {month.grants.length === 0 && <Empty colSpan={4}>No grants yet.</Empty>}
          {month.grants.map((g) => (
            <tr key={g.tool}>
              <Td className="font-mono text-[12px]">{g.tool}</Td>
              <Td className="tabular-nums">{g.grants}</Td>
              <Td className="tabular-nums">{g.uses}</Td>
              <Td className="tabular-nums">{g.maxUses}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Kill list"
        description="Tools removed from every agent's belt (operator.disabledTools)."
      >
        <p className="font-mono text-[12.5px]">{killList?.trim() ? killList : "None"}</p>
      </Section>
    </>
  )
}
