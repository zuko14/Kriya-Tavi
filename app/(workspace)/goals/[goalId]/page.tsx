import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotIcon,
  OctagonXIcon,
} from "lucide-react"

import { CapForm, GoalControls, ScheduleControls } from "@/components/inbox/controls"
import { JobPanel } from "@/components/operator/job-panel"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { formatInr, parseRate } from "@/lib/money"
import { quoteFor } from "@/lib/quotes"
import { cn } from "@/lib/utils"
import { getGoal } from "@/queries/goals"
import { jobForGoal } from "@/queries/mandates"

export const metadata: Metadata = { title: "Goal" }

// A goal (A3, UX_SPEC §5): checklist with proof, the schedules that work on
// it, this month's spend against its ₹ budget, and what was done for it.

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
})

const ITEM = {
  todo: { icon: CircleDashedIcon, tone: "text-muted-foreground" },
  doing: { icon: CircleDotIcon, tone: "text-rigel" },
  done: { icon: CheckIcon, tone: "text-ok" },
  blocked: { icon: OctagonXIcon, tone: "text-destructive" },
} as const

const PAUSED: Record<string, string> = {
  limit: "paused: plan limit reached",
  budget: "paused: ₹ budget reached",
  goal: "paused with the goal",
  person: "paused by you",
  agent: "paused by your agent",
  rule: "paused: its rule can't be read",
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="label-mono px-1">{title}</h2>
      {children}
    </section>
  )
}

export default async function Page({ params }: { params: Promise<{ goalId: string }> }) {
  const user = await requireUser()
  if ((await getSetting("agents.goals")) !== "on") notFound()
  const { goalId } = await params
  const view = await getGoal(user.id, goalId.slice(0, 32))
  if (!view) notFound()
  const { goal } = view
  const quotes = (await getSetting("agents.quotes")) === "on"
  const capsAvailable = parseRate(await getSetting("fx.usdInr")) !== null
  const estimates = quotes
    ? await Promise.all(
        view.schedules.map((s) => quoteFor(user.id, { scheduleId: s.id }))
      )
    : []
  const seqOf = new Map(view.episodes.map((e) => [e.id, e.seq]))
  // O3: the job that owns this goal, if any; goals without one are unchanged
  const job =
    (await getSetting("operator.mandates")) === "on"
      ? await jobForGoal(
          user.id,
          goal.id,
          (await getSetting("operator.reports")) === "on" &&
            (await getSetting("agents.files")) === "on"
        )
      : null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-2">
          <Link
            href="/goals"
            className="label-mono flex min-h-11 w-fit min-w-11 items-center text-faint sm:min-h-0"
          >
            Goals
          </Link>
          <h1 className="font-display text-[28px] leading-tight font-normal text-balance sm:text-[34px]">
            {goal.title}
          </h1>
          <span className="font-mono text-[11px] text-muted-foreground">
            {goal.status}
          </span>
          {goal.successCriteria && (
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Done when: {goal.successCriteria}
            </p>
          )}
          {!job && <GoalControls goalId={goal.id} status={goal.status} />}
        </header>

        {job && <JobPanel view={job} />}

        <Block title="Checklist">
          {goal.plan.length === 0 ? (
            <p className="glass rounded-[20px] px-4 py-4 text-[13px] text-muted-foreground">
              No checklist yet. Ask your agent in the goal&apos;s thread to plan it.
            </p>
          ) : (
            <ul className="glass divide-y overflow-hidden rounded-[20px]">
              {goal.plan.map((item) => {
                const { icon: Icon, tone } = ITEM[item.status]
                const seq = item.evidence ? seqOf.get(item.evidence) : undefined
                return (
                  <li
                    key={item.id}
                    className="flex min-h-12 items-center gap-3 px-4 py-2.5"
                  >
                    <Icon
                      className={cn("size-4 shrink-0", tone)}
                      aria-label={item.status}
                    />
                    <span className="flex-1 text-[13.5px]">{item.text}</span>
                    {item.evidence && (
                      <span className="rounded-full bg-ok/10 px-2 py-0.5 font-mono text-[10.5px] text-ok">
                        {seq ? `proof · record #${seq}` : "proof"}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Block>

        <Block title="Schedules">
          {view.schedules.length === 0 ? (
            <p className="glass rounded-[20px] px-4 py-4 text-[13px] text-muted-foreground">
              Nothing runs on its own for this goal yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {view.schedules.map((s, i) => {
                const quote = estimates[i]
                return (
                  <li
                    key={s.id}
                    className="glass flex flex-col gap-2.5 rounded-[20px] px-4 py-4"
                  >
                    <span className="text-[14px] font-medium">{s.cadence}</span>
                    {/* U3: the prompt is written for the agent; two lines, tap for all */}
                    <details className="group/prompt text-[13px] text-muted-foreground">
                      <summary className="line-clamp-2 cursor-pointer list-none group-open/prompt:line-clamp-none [&::-webkit-details-marker]:hidden">
                        {s.prompt}
                      </summary>
                    </details>
                    <span className="font-mono text-[11px] text-faint">
                      {s.status === "active" && s.nextRunAt
                        ? `next ${IST.format(s.nextRunAt)}`
                        : s.status === "paused"
                          ? (PAUSED[s.pauseReason ?? ""] ?? "paused")
                          : "ended"}{" "}
                      · {s.runs} {s.runs === 1 ? "run" : "runs"} so far
                    </span>
                    {quotes && (
                      <span className="text-[12.5px] text-muted-foreground">
                        {quote
                          ? `Usually ${formatInr(quote.p50MicroInr)}–${formatInr(quote.p90MicroInr)} a run (from ${quote.samples} earlier runs${quote.estimated ? ", some estimated" : ""})`
                          : "No estimate yet"}
                      </span>
                    )}
                    <ScheduleControls scheduleId={s.id} status={s.status} />
                    {quotes &&
                      s.status !== "ended" &&
                      (capsAvailable ? (
                        <CapForm
                          target="schedule"
                          id={s.id}
                          currentMicroInr={s.capMicroInr}
                          label="₹ limit per run"
                        />
                      ) : (
                        <span className="text-[12px] text-faint">
                          ₹ cap unavailable: exchange rate not configured
                        </span>
                      ))}
                  </li>
                )
              })}
            </ul>
          )}
        </Block>

        <Block title="Spend this month">
          <div className="glass flex flex-col gap-2 rounded-[20px] px-4 py-4">
            <span className="text-[15px] font-medium tabular-nums">
              {formatInr(view.spentMicroInr)}
              {view.budgetMicroInr ? ` of ${formatInr(view.budgetMicroInr)}` : ""}
            </span>
            {view.unpricedRuns > 0 && (
              <span className="text-[12px] text-muted-foreground">
                {view.unpricedRuns === 1
                  ? "1 run has no price yet and isn't counted."
                  : `${view.unpricedRuns} runs have no price yet and aren't counted.`}
              </span>
            )}
            {quotes && (
              <CapForm
                target="goal"
                id={goal.id}
                currentMicroInr={view.budgetMicroInr}
                label="Monthly ₹ budget (pauses its schedules when reached)"
              />
            )}
          </div>
        </Block>

        <Block title="What was done">
          {view.episodes.length === 0 ? (
            <p className="glass rounded-[20px] px-4 py-4 text-[13px] text-muted-foreground">
              No checked actions yet.
            </p>
          ) : (
            <ul className="glass divide-y overflow-hidden rounded-[20px]">
              {view.episodes.map((e) => (
                <li key={e.id} className="flex flex-col gap-1 px-4 py-3">
                  {e.done.map((d) => (
                    <span
                      key={d.executionId}
                      className="flex items-start gap-2 text-[13.5px]"
                    >
                      <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-ok" />
                      {d.title}
                    </span>
                  ))}
                  <span className="font-mono text-[10.5px] text-faint">
                    record #{e.seq} · {IST.format(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        {view.href && (
          <Link
            href={view.href}
            className="glass flex min-h-14 items-center justify-between rounded-2xl px-4 text-[13.5px] font-medium"
          >
            Open the goal&apos;s thread
            <ChevronRightIcon className="size-4 text-faint" />
          </Link>
        )}
      </div>
    </div>
  )
}
