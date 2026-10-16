import { formatDistanceToNowStrict } from "date-fns"

import { Bars, Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { formatInr, formatUsd } from "@/lib/money"
import { finance, overview } from "@/lib/owner"

export default async function OwnerOverview() {
  await requireOwner()
  const [data, money] = await Promise.all([overview(), finance(30)])
  // OpenRouter bills the owner for both: what it reported, and our estimate where it didn't
  const spend = money.usage.reported + money.usage.estimated
  const perMember = data.active.mau ? Math.round(spend / data.active.mau) : 0
  const states = data.taskStates
  const finished = (states.succeeded ?? 0) + (states.failed ?? 0)
  const failRate = finished ? Math.round(((states.failed ?? 0) / finished) * 100) : 0
  const healthy = data.workers.filter((worker) => worker.healthy)

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Overview
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Active users are people who started at least one task in the window (a day for
          DAU, 30 days for MAU).
        </p>
      </header>

      <section
        aria-label="At a glance"
        className="glass relative grid gap-6 overflow-hidden rounded-[24px] p-5 sm:grid-cols-2 sm:p-7 lg:grid-cols-4"
      >
        <span className="absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-betelgeuse/60 to-transparent" />
        {[
          {
            label: "members",
            value: data.users.total.toLocaleString("en-IN"),
            hint: `${data.users.new7} joined this week`,
          },
          {
            label: "active · 30 days",
            value: data.active.mau.toLocaleString("en-IN"),
            hint: `${data.active.dau} today`,
          },
          {
            label: "OpenRouter spend · 30 days",
            value: formatUsd(spend),
            hint:
              money.usage.estimated > 0
                ? `${formatUsd(money.usage.estimated)} of it estimated`
                : "all reported by the provider",
          },
          {
            label: "spend per active member",
            value: formatUsd(perMember),
            hint: `customers charged ${formatInr(money.taskCosts.charged)}`,
          },
        ].map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col gap-2">
            <span className="label-mono truncate">{item.label}</span>
            <span className="truncate font-display text-[36px] leading-none tabular-nums sm:text-[42px]">
              {item.value}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">
              {item.hint}
            </span>
          </div>
        ))}
      </section>

      <Tiles>
        <Tile
          label="users"
          value={data.users.total}
          hint={`${data.users.new7} new this week`}
        />
        <Tile label="new · 30 days" value={data.users.new30} />
        <Tile label="DAU" value={data.active.dau} />
        <Tile label="MAU" value={data.active.mau} />
        <Tile
          label="queued now"
          value={data.queue.queued}
          tone={data.queue.queued > 20 ? "warn" : undefined}
        />
        <Tile label="running now" value={data.queue.running} />
        <Tile
          label="failed · 24h"
          value={`${states.failed ?? 0} (${failRate}%)`}
          tone={failRate > 10 ? "bad" : undefined}
        />
        <Tile
          label="workers"
          value={`${healthy.length} healthy`}
          tone={healthy.length === 0 ? "bad" : "good"}
          hint={`${data.workers.length - healthy.length} silent`}
        />
      </Tiles>

      <Section
        title="Tasks and failures · last 14 days"
        description="Teal: tasks that finished. Terracotta: failed."
      >
        <Bars
          label="Tasks and failures per day"
          data={data.failuresByDay.map((day) => ({
            key: day.day,
            a: day.total - day.failed,
            b: day.failed,
            title: `${day.day}: ${day.total} tasks, ${day.failed} failed`,
          }))}
        />
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Paid subscriptions">
          <Table head={["plan", "active"]}>
            {data.planMix.length === 0 && (
              <Empty colSpan={2}>No paid subscriptions yet.</Empty>
            )}
            {data.planMix.map((row) => (
              <tr key={row.planId}>
                <Td className="font-mono">{row.planId}</Td>
                <Td className="font-mono tabular-nums">{row.count}</Td>
              </tr>
            ))}
          </Table>
          <p className="text-[12px] text-muted-foreground">
            {data.users.suspended} suspended account(s).
          </p>
        </Section>
        <Section title="Workers">
          <Table head={["worker", "running", "heartbeat"]}>
            {data.workers.length === 0 && (
              <Empty colSpan={3}>
                No worker has checked in. Tasks will queue but not run.
              </Empty>
            )}
            {data.workers.map((worker) => (
              <tr key={worker.id}>
                <Td className="font-mono text-[11.5px]">
                  <span
                    className={worker.healthy ? "text-ok" : "text-destructive"}
                    aria-label={worker.healthy ? "healthy" : "silent"}
                  >
                    ●
                  </span>{" "}
                  {worker.id}
                </Td>
                <Td className="font-mono tabular-nums">
                  {worker.running}/{worker.concurrency}
                </Td>
                <Td className="font-mono text-[11.5px] text-muted-foreground">
                  {formatDistanceToNowStrict(worker.heartbeatAt, { addSuffix: true })}
                </Td>
              </tr>
            ))}
          </Table>
        </Section>
      </div>
    </>
  )
}
