import type { Metadata } from "next"
import Link from "next/link"
import { format, formatDistanceToNowStrict, subDays } from "date-fns"

import { Glyph } from "@/components/glyph"
import { requireUser } from "@/lib/auth"
import { usageSummary } from "@/lib/entitlements"
import { formatInr } from "@/lib/money"
import { tierName } from "@/lib/tiers"
import { cn } from "@/lib/utils"
import { getUsage } from "@/queries/workspace"

export const metadata: Metadata = { title: "Usage" }

const compact = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
})

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-surface/60 px-4 py-3.5">
      <span className="label-mono">{label}</span>
      <span className="font-mono text-xl font-medium tracking-tight tabular-nums sm:text-2xl">
        {value}
      </span>
      {hint && <span className="font-mono text-[10.5px] text-faint">{hint}</span>}
    </div>
  )
}

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-ok",
  failed: "text-destructive",
  canceled: "text-muted-foreground",
  running: "text-rigel",
  queued: "text-muted-foreground",
}

export default async function Page() {
  const user = await requireUser()
  const [usage, summary] = await Promise.all([
    getUsage(user.id, 30),
    usageSummary(user.id),
  ])
  const { totals } = usage

  // Fill every day of the window so quiet days show as gaps
  const byDay = new Map(usage.daily.map((d) => [d.day, d]))
  const days = Array.from({ length: usage.days }, (_, i) => {
    const date = subDays(new Date(), usage.days - 1 - i)
    const key = format(date, "yyyy-MM-dd")
    return {
      key,
      date,
      tasks: byDay.get(key)?.tasks ?? 0,
      charge: byDay.get(key)?.charge ?? 0,
    }
  })
  const peak = Math.max(1, ...days.map((d) => d.tasks))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:gap-10 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-2">
          <span className="label-mono">{`// last ${usage.days} days`}</span>
          <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
          <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground">
            Every task is metered: the model calls it made, the tokens they used and what
            that cost, in rupees. Costs marked <em>est.</em> include an estimate where the
            model provider didn&apos;t report one.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4">
          <Stat
            label="tasks"
            value={compact.format(totals.tasks)}
            hint={totals.failed ? `${totals.failed} failed` : "none failed"}
          />
          <Stat
            label="spent"
            value={formatInr(totals.charge)}
            hint={totals.estimated ? `${totals.estimated} estimated` : "all reported"}
          />
          <Stat
            label="tokens"
            value={compact.format(usage.tokens.input + usage.tokens.output)}
            hint={`${compact.format(usage.tokens.calls)} model calls`}
          />
          <Stat
            label="this period"
            value={formatInr(summary.usedMicroInr)}
            hint={
              summary.allowanceMicroInr > 0
                ? `of ${formatInr(summary.allowanceMicroInr)} included`
                : `${summary.plan.name} plan`
            }
          />
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="label-mono">tasks per day</h2>
          <div className="rounded-xl border bg-surface/50 p-4">
            <div
              className="flex h-32 items-end gap-[2px] sm:h-40 sm:gap-[3px]"
              role="img"
              aria-label={`Tasks per day over the last ${usage.days} days`}
            >
              {days.map((day) => (
                <div
                  key={day.key}
                  className="group relative flex h-full flex-1 items-end"
                >
                  <div
                    className={cn(
                      "w-full rounded-t-[2px] transition-colors",
                      day.tasks ? "bg-rigel/70 group-hover:bg-rigel" : "bg-border"
                    )}
                    style={{
                      height: day.tasks
                        ? `${Math.max(3, (day.tasks / peak) * 100)}%`
                        : "2px",
                    }}
                  />
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 rounded-md border bg-popover px-2 py-1 font-mono text-[10.5px] whitespace-nowrap shadow-md group-hover:block">
                    {format(day.date, "d MMM")} · {day.tasks} tasks ·{" "}
                    {formatInr(day.charge)}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between font-mono text-[10px] text-faint">
              <span>{format(days[0].date, "d MMM")}</span>
              <span>today</span>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="label-mono">by agent</h2>
          <div className="divide-y rounded-xl border bg-surface/50 text-[13px]">
            {usage.byAgent.length === 0 && (
              <p className="px-4 py-3 text-muted-foreground">No tasks yet.</p>
            )}
            {usage.byAgent.map((row) => (
              <div
                key={row.agentId ?? "none"}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                {row.glyph && <Glyph seed={row.glyph} className="size-5" />}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {row.name ?? "Deleted agent"}
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">
                  {row.tasks} tasks
                </span>
                <span className="w-24 text-right font-mono text-[12px] tabular-nums">
                  {formatInr(row.charge)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="label-mono">recent tasks</h2>
          <ul className="divide-y rounded-xl border bg-surface/50">
            {usage.recent.length === 0 && (
              <li className="px-4 py-4 text-[13px] text-muted-foreground">
                Nothing yet. Give an agent a task and it lands here.
              </li>
            )}
            {usage.recent.map((task) => {
              const href = task.squadId
                ? `/s/${task.squadId}/${task.threadId}`
                : `/a/${task.agentId}/${task.threadId}`
              return (
                <li key={task.id}>
                  <Link
                    href={href}
                    className="flex items-center gap-3 px-4 py-3 text-[13px] transition-colors hover:bg-accent/30"
                  >
                    {task.agentGlyph && (
                      <Glyph seed={task.agentGlyph} className="size-6 rounded-[5px]" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate font-medium">
                        {task.agentName ?? "—"}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatDistanceToNowStrict(task.createdAt, { addSuffix: true })} ·{" "}
                        {tierName(task.tier).toLowerCase()}
                      </span>
                    </span>
                    <span
                      className={cn("font-mono text-[11.5px]", STATUS_TONE[task.status])}
                    >
                      {task.status === "succeeded" ? "done" : task.status}
                    </span>
                    <span className="w-24 text-right font-mono text-[12px] tabular-nums">
                      {task.charge == null ? "—" : formatInr(task.charge)}
                      {task.chargeStatus === "estimated" && (
                        <span className="text-betelgeuse"> est.</span>
                      )}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
          {summary.unpricedTasks > 0 && (
            <p className="font-mono text-[10.5px] text-faint">
              {summary.unpricedTasks} task(s) this period aren&apos;t priced yet and
              aren&apos;t counted against your allowance.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
