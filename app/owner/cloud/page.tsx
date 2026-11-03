import type { Metadata } from "next"
import { formatDistanceToNowStrict } from "date-fns"

import { Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { formatInr, formatUsd, parseRate, usdToInr } from "@/lib/money"
import { getCloudOverview, getExecMetrics, type ExecMetrics } from "@/queries/cloud"

export const metadata: Metadata = { title: "Cloud" }

// Cloud workspaces (track C, UX_SPEC §5): what runs now against the cap,
// this month's compute and what it cost the platform. The cost is only what
// the owner's hourly rate priced; unpriced sessions are counted, never ₹0.
// People by id, as other owner pages; no code, output or checkpoint here.
// Read-only; switches are edited in Config.

const mb = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
const minutes = (seconds: number) => Math.round(seconds / 60).toLocaleString("en-IN")
const age = (seconds: number | null) =>
  seconds === null
    ? "never"
    : seconds < 120
      ? `${seconds} s`
      : seconds < 7200
        ? `${Math.round(seconds / 60)} min`
        : `${Math.round(seconds / 3600)} h`
const wait = (seconds: number | null) =>
  seconds === null ? "—" : `${seconds.toFixed(1)} s`
const gb = (mb: number) => (mb / 1024).toFixed(1)
const pct = (value: number | null) => (value === null ? "—" : String(value))

// The self-hosted fabric (SH7): kriya.exec_metrics() as it stands, read-only.
// Shown only when the fabric is in use, so the page is otherwise unchanged.
function Fabric({ metrics }: { metrics: ExecMetrics }) {
  const hour = metrics.lastHour
  return (
    <Section
      title="Self-hosted nodes"
      description="The capacity queue and each node's last report. Granted, failed starts and waits cover the last hour. Reserved is what granted sandboxes hold; PSI is pressure (some avg10 %)."
    >
      <Tiles>
        <Tile
          label="queued now"
          value={String(metrics.waiting)}
          hint={`oldest ${metrics.waiting ? age(metrics.oldestWaitSeconds) : "—"}`}
        />
        <Tile
          label="granted"
          value={String(hour.granted)}
          hint={`${hour.expired} expired · ${hour.cancelled} cancelled`}
        />
        <Tile
          label="failed starts"
          value={String(hour.startFailed)}
          tone={hour.startFailed ? "bad" : undefined}
        />
        <Tile
          label="wait p95"
          value={wait(hour.waitP95)}
          hint={`p50 ${wait(hour.waitP50)} · p99 ${wait(hour.waitP99)}`}
        />
      </Tiles>
      <Table
        head={[
          "node",
          "status",
          "isolation",
          "report",
          "cpu cores",
          "memory GB",
          "disk GB",
          "psi cpu/mem/io",
          "free disk",
          "reason",
        ]}
      >
        {metrics.nodes.length === 0 && <Empty colSpan={10}>No nodes registered.</Empty>}
        {metrics.nodes.map((node) => (
          <tr key={node.id}>
            <Td className="font-mono text-[11.5px] whitespace-nowrap">{node.id}</Td>
            <Td className="whitespace-nowrap">
              {node.status} ·{" "}
              <span className={node.healthy ? "text-ok" : "text-destructive"}>
                {node.healthy ? "healthy" : "unhealthy"}
              </span>
            </Td>
            <Td>{node.isolation ?? "—"}</Td>
            <Td className="whitespace-nowrap">{age(node.statsAgeSeconds)}</Td>
            <Td className="font-mono whitespace-nowrap tabular-nums">
              {(node.cpuReserved / 1000).toFixed(1)} /{" "}
              {(node.cpuMillis / 1000).toFixed(1)}
            </Td>
            <Td className="font-mono whitespace-nowrap tabular-nums">
              {gb(node.memReserved)} / {gb(node.memMb)}
            </Td>
            <Td className="font-mono whitespace-nowrap tabular-nums">
              {gb(node.diskReserved)} / {gb(node.diskMb)}
            </Td>
            <Td className="font-mono whitespace-nowrap tabular-nums">
              {pct(node.psiCpu)} / {pct(node.psiMem)} / {pct(node.psiIo)}
            </Td>
            <Td className="font-mono whitespace-nowrap tabular-nums">
              {node.diskFreeMb === null ? "—" : `${gb(node.diskFreeMb)} GB`}
            </Td>
            <Td className="max-w-64 truncate">{node.reason ?? "—"}</Td>
          </tr>
        ))}
      </Table>
    </Section>
  )
}

export default async function OwnerCloud() {
  await requireOwner()
  const [overview, fabric] = await Promise.all([getCloudOverview(), getExecMetrics()])
  const rate = parseRate(await getSetting("fx.usdInr"))
  const { month } = overview
  const cost =
    month.costMicroUsd === 0 && month.unpricedSessions > 0
      ? "unpriced"
      : rate
        ? formatInr(usdToInr(month.costMicroUsd, rate))
        : formatUsd(month.costMicroUsd)

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Cloud
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Cloud workspaces this month (India time). Compute is included in each
          plan&apos;s minutes; it isn&apos;t charged to people.
        </p>
      </header>

      <Tiles>
        <Tile
          label="running now"
          value={`${overview.running} / ${overview.maxRunning}`}
          hint="against cloud.maxRunning"
          tone={overview.running >= overview.maxRunning ? "warn" : undefined}
        />
        <Tile
          label="paused"
          value={String(overview.paused)}
          hint="kept until pausedHours"
        />
        <Tile
          label="minutes this month"
          value={minutes(month.seconds)}
          hint={`saved changes ${mb(overview.storedBytes)}`}
        />
        <Tile
          label="platform cost"
          value={cost}
          hint={
            month.unpricedSessions
              ? `${month.unpricedSessions} ${month.unpricedSessions === 1 ? "session" : "sessions"} unpriced${overview.rateSet ? "" : " (no hourly rate set)"}`
              : rate
                ? "all priced"
                : "no USD→INR rate: shown in USD"
          }
        />
      </Tiles>

      <Section
        title="Workspaces"
        description="The 50 most recently active. Minutes are each workspace's sessions; saved changes are its latest checkpoint."
      >
        <Table
          head={["person", "repository", "status", "last active", "minutes", "saved"]}
        >
          {overview.rows.length === 0 && <Empty colSpan={6}>No workspaces yet.</Empty>}
          {overview.rows.map((row) => (
            <tr key={row.id}>
              <Td className="font-mono text-[11.5px]">{row.userId.slice(0, 8)}</Td>
              <Td className="max-w-48 truncate font-mono text-[11.5px]">
                {row.repo ?? "blank"}
              </Td>
              <Td>{row.status}</Td>
              <Td>{formatDistanceToNowStrict(row.lastActiveAt, { addSuffix: true })}</Td>
              <Td className="font-mono tabular-nums">{minutes(row.seconds)}</Td>
              <Td className="font-mono tabular-nums">
                {row.checkpointBytes ? mb(row.checkpointBytes) : "—"}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>

      {fabric && <Fabric metrics={fabric} />}
    </>
  )
}
