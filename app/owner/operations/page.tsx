import type { Metadata } from "next"
import Link from "next/link"
import { formatDistanceToNowStrict } from "date-fns"

import { ReconcileButton, RetryTaskButton } from "@/components/owner/forms"
import { Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { formatInr } from "@/lib/money"
import { backgroundCounts, operations, voiceOperations } from "@/lib/owner"

export const metadata: Metadata = { title: "Operations" }

const ago = (value: Date | null) =>
  value ? formatDistanceToNowStrict(value, { addSuffix: true }) : "—"

export default async function OwnerOperations() {
  await requireOwner()
  const [ops, background, voice] = await Promise.all([
    operations(),
    backgroundCounts(),
    voiceOperations(),
  ])
  const live = ops.workers.filter((worker) => worker.live)

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Operations
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Errors are shown as stored (already redacted). Task content is never shown here.
        </p>
      </header>

      <Tiles>
        <Tile
          label="live workers"
          value={live.length}
          tone={live.length ? "good" : "bad"}
        />
        <Tile label="failed (recent)" value={ops.failed.length} />
        <Tile
          label="stuck > 15 min"
          value={ops.stuck.length}
          tone={ops.stuck.length ? "warn" : undefined}
        />
        <Tile
          label="costs to reconcile"
          value={ops.reconcile.pending}
          hint={`${ops.reconcile.unrecoverable} without a generation id`}
          tone={ops.reconcile.pending ? "warn" : undefined}
        />
      </Tiles>

      <Section
        title="Phone calls"
        description="Today's voice spend against the daily cap (alert at 80 %), calls by state, attempts in the last 24 hours, and owners near their allowance. Counts only: nothing that was said."
      >
        {((voice.capPct ?? 0) >= 80 || voice.nearAllowance.length > 0) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 px-3 py-2 text-[13px] text-destructive"
          >
            {(voice.capPct ?? 0) >= 80 &&
              `Voice spend is at ${voice.capPct}% of today's cap. `}
            {voice.nearAllowance.length > 0 &&
              `${voice.nearAllowance.length} owner(s) at 80% or more of their allowance.`}
          </p>
        )}
        <Tiles>
          <Tile
            label="voice spend today"
            value={
              voice.spentMicroInr == null
                ? "FX rate not set"
                : formatInr(voice.spentMicroInr)
            }
            hint={`${voice.unmeteredToday} unmetered items`}
          />
          <Tile
            label="daily cap"
            value={voice.capMicroInr == null ? "not set" : formatInr(voice.capMicroInr)}
            hint={
              voice.capPct == null ? "no live calls until set" : `${voice.capPct}% used`
            }
            tone={
              voice.capPct == null
                ? "warn"
                : voice.capPct >= 100
                  ? "bad"
                  : voice.capPct >= 80
                    ? "warn"
                    : "good"
            }
          />
          <Tile
            label="stuck calls"
            value={voice.stuck}
            tone={voice.stuck ? "warn" : undefined}
            hint="lease expired while dialing or on a call"
          />
          <Tile
            label="needs the owner"
            value={voice.calls
              .filter((c) => c.status === "needs_owner")
              .reduce((s, c) => s + c.n, 0)}
          />
        </Tiles>
        <div className="grid gap-8 lg:grid-cols-2">
          <Table head={["call", "state", "count"]}>
            {voice.calls.length === 0 && <Empty colSpan={3}>No open calls.</Empty>}
            {voice.calls.map((row) => (
              <tr key={`${row.kind}:${row.status}`}>
                <Td>{row.kind}</Td>
                <Td>{row.status}</Td>
                <Td className="font-mono tabular-nums">{row.n}</Td>
              </tr>
            ))}
          </Table>
          <Table head={["attempt ended", "reason", "24 h"]}>
            {voice.attempts.length === 0 && <Empty colSpan={3}>No attempts today.</Empty>}
            {voice.attempts.map((row) => (
              <tr key={`${row.status}:${row.end_reason}`}>
                <Td>{row.status}</Td>
                <Td>{row.end_reason ?? "—"}</Td>
                <Td className="font-mono tabular-nums">{row.n}</Td>
              </tr>
            ))}
          </Table>
        </div>
        {voice.nearAllowance.length > 0 && (
          <Table head={["owner", "plan", "allowance used"]}>
            {voice.nearAllowance.map((row) => (
              <tr key={row.userId}>
                <Td>
                  <Link
                    href={`/owner/users/${row.userId}`}
                    className="text-rigel hover:underline"
                  >
                    {row.userId}
                  </Link>
                </Td>
                <Td>{row.plan}</Td>
                <Td className="font-mono tabular-nums">{row.usedPct}%</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Background runs"
        description="Goals, schedules, approvals and What I did records: counts only, never their content. Every fire is enqueued, skipped with a reason or failed; claimed runs are recovered after 2 minutes."
      >
        <Tiles>
          <Tile label="open goals" value={background.openGoals} />
          <Tile
            label="schedules"
            value={background.activeSchedules}
            hint={`${background.pausedSchedules} paused`}
          />
          <Tile
            label="runs (7 days)"
            value={background.runs7d}
            hint={`${background.enqueued7d} enqueued · ${background.skipped7d} skipped · ${background.failed7d} failed`}
            tone={background.failed7d ? "warn" : undefined}
          />
          <Tile
            label="claimed, not enqueued"
            value={background.claimedNow}
            tone={background.claimedNow ? "warn" : undefined}
          />
          <Tile
            label="approvals pending"
            value={background.pendingApprovals}
            hint={`${background.expired7d} expired this week`}
          />
          <Tile label="records (7 days)" value={background.episodes7d} />
        </Tiles>
      </Section>

      <Section
        title="Cost reconciliation"
        description="Looks up model calls that finished without a reported cost in OpenRouter's generation records, then reprices estimated or unpriced charges. Final charges are never changed."
        aside={<ReconcileButton />}
      >
        <span />
      </Section>

      <Section
        title="Failed tasks"
        description="Retry requeues a task for one more attempt. It's refused if the task ran anything with side effects."
      >
        <Table head={["task", "user", "error", "attempts", "finished", ""]}>
          {ops.failed.length === 0 && <Empty colSpan={6}>No failed tasks.</Empty>}
          {ops.failed.map((task) => (
            <tr key={task.id}>
              <Td className="font-mono text-[11px]">
                {task.id.slice(0, 8)}
                <div className="text-muted-foreground">
                  {task.tier} · {task.model ?? "—"}
                </div>
              </Td>
              <Td>
                <Link
                  href={`/owner/users/${task.userId}`}
                  className="font-mono text-[11px] text-rigel hover:underline"
                >
                  {task.userId.slice(0, 8)}
                </Link>
              </Td>
              <Td className="max-w-80">
                <span className="font-mono text-[11px] text-destructive">
                  {task.errorCode}
                </span>
                <div className="line-clamp-2 text-[12px] text-muted-foreground">
                  {task.error}
                </div>
              </Td>
              <Td className="font-mono tabular-nums">
                {task.attempts}/{task.maxAttempts}
              </Td>
              <Td className="text-[11.5px] text-muted-foreground">
                {ago(task.finishedAt)}
              </Td>
              <Td>
                {task.sideEffects ? (
                  <span className="text-[11px] text-muted-foreground">side effects</span>
                ) : (
                  <RetryTaskButton taskId={task.id} />
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Stuck tasks"
        description="Queued or running for over 15 minutes. Recovery requeues tasks whose worker stopped heartbeating; tasks here with a live lease are just slow."
      >
        <Table head={["task", "status", "lease", "created"]}>
          {ops.stuck.length === 0 && <Empty colSpan={4}>Nothing stuck.</Empty>}
          {ops.stuck.map((task) => (
            <tr key={task.id}>
              <Td className="font-mono text-[11px]">{task.id}</Td>
              <Td>{task.status}</Td>
              <Td className="font-mono text-[11px]">{task.leaseOwner ?? "—"}</Td>
              <Td className="text-[11.5px] text-muted-foreground">
                {ago(task.createdAt)}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Workers">
          <Table head={["worker", "version", "running", "heartbeat"]}>
            {ops.workers.length === 0 && (
              <Empty colSpan={4}>No worker has started yet.</Empty>
            )}
            {ops.workers.map((worker) => (
              <tr key={worker.id}>
                <Td className="font-mono text-[11px]">{worker.id}</Td>
                <Td className="font-mono text-[11px]">{worker.version ?? "—"}</Td>
                <Td className="font-mono tabular-nums">
                  {worker.stoppedAt
                    ? "stopped"
                    : `${worker.running}/${worker.concurrency}`}
                </Td>
                <Td className="text-[11.5px] text-muted-foreground">
                  {ago(worker.heartbeatAt)}
                </Td>
              </tr>
            ))}
          </Table>
        </Section>
        <Section
          title="Configuration status"
          description="Presence only. Values are never shown."
        >
          <Table head={["secret", "status"]}>
            {ops.secrets.map((secret) => (
              <tr key={secret.name}>
                <Td className="font-mono text-[11.5px]">{secret.name}</Td>
                <Td className={secret.set ? "text-ok" : "text-betelgeuse"}>
                  {secret.set ? "set" : "missing"}
                </Td>
              </tr>
            ))}
          </Table>
        </Section>
      </div>
    </>
  )
}
