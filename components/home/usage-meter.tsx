import Link from "next/link"
import { BrainIcon, GlobeIcon, MonitorOffIcon, UsersIcon } from "lucide-react"

import { formatInr } from "@/lib/money"
import { cn } from "@/lib/utils"
import type { SystemStatus } from "@/queries/workspace"

// Plan, today's tasks and this period's spend in rupees, plus what agents
// can and can't do today. Warns before a limit, not after.
export function UsageMeter({ status }: { status: SystemStatus }) {
  const { plan, usage } = status
  const taskPct = Math.min(
    100,
    Math.round((usage.tasksToday / Math.max(plan.maxTasksPerDay, 1)) * 100)
  )
  const capabilities = [
    { icon: GlobeIcon, label: "Web research with sources", on: status.web },
    { icon: BrainIcon, label: "Memory you can inspect and edit", on: true },
    { icon: UsersIcon, label: "Squads that work in parallel", on: true },
    { icon: MonitorOffIcon, label: "Computer and browser use (coming)", on: false },
  ]
  return (
    <section className="grid gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-[1.2fr_1fr]">
      <div className="flex flex-col gap-4 bg-surface p-5">
        <div className="flex items-center justify-between">
          <span className="label-mono">{plan.name} plan</span>
          <Link href="/account#plan" className="text-[12px] text-rigel hover:underline">
            {plan.id === "free" ? "Upgrade" : "Manage"}
          </Link>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between text-[13px]">
            <span>Tasks today</span>
            <span className="font-mono tabular-nums">
              {usage.tasksToday} / {plan.maxTasksPerDay}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Tasks used today"
            aria-valuenow={taskPct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-full",
                usage.warn ? "bg-betelgeuse" : "bg-rigel"
              )}
              style={{ width: `${taskPct}%` }}
            />
          </div>
        </div>
        <div className="flex items-baseline justify-between text-[13px]">
          <span>AI usage this period</span>
          <span className="font-mono tabular-nums">
            {formatInr(usage.usedMicroInr)}
            {usage.allowanceMicroInr > 0 && (
              <span className="text-muted-foreground">
                {" "}
                of {formatInr(usage.allowanceMicroInr)}
              </span>
            )}
          </span>
        </div>
        {usage.blocked ? (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-[12.5px]"
          >
            {usage.blocked}
          </p>
        ) : usage.warn ? (
          <p className="rounded-lg bg-betelgeuse-soft px-3 py-2 text-[12.5px]">
            You&apos;re close to your plan&apos;s limit.
          </p>
        ) : null}
        {!status.ready && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-[12.5px]"
          >
            Kriya can&apos;t reach its AI models right now. Tasks will fail until
            it&apos;s back.
          </p>
        )}
      </div>
      <ul className="flex flex-col justify-center gap-2.5 bg-surface p-5 text-[13px]">
        {capabilities.map(({ icon: Icon, label, on }) => (
          <li
            key={label}
            className={cn("flex items-center gap-2.5", !on && "text-muted-foreground")}
          >
            <Icon className={cn("size-4", on ? "text-betelgeuse" : "text-faint")} />
            {label}
          </li>
        ))}
      </ul>
    </section>
  )
}
