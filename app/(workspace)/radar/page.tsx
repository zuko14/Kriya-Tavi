import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { and, eq } from "drizzle-orm"

import { ScheduleControls } from "@/components/inbox/controls"
import { ObligationButtons } from "@/components/radar/controls"
import { withUser } from "@/db"
import { schedules, watchState } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { upcomingObligations } from "@/lib/radar/obligations"
import { describeRule, ruleSchema } from "@/lib/schedules"

export const metadata: Metadata = { title: "Radar" }

// Radar (K4) and Watchers (K5), UX_SPEC §13: each deadline with the exact
// quote and source it came from, "Not verified" when code couldn't find
// the quote or the date in it. Reminders show here until phone-call
// reminders ship (AD-20). Watchers: what's watched, how often, last check.

const DAY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
})
const READ = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
})
const WHEN = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})

const source = (kind: string, ref: string) => {
  if (kind === "person") return "you"
  if (kind === "gmail") return "your mail"
  if (kind === "public_fact") return "Kriya's public facts"
  try {
    return new URL(ref).hostname
  } catch {
    return ref
  }
}

export default async function RadarPage() {
  const user = await requireUser()
  const radar = (await getSetting("agents.radar")) === "on"
  const watchers = (await getSetting("agents.watchers")) === "on"
  if (!radar && !watchers) notFound()

  const items = radar ? await upcomingObligations(user.id) : []
  const watched = watchers
    ? await withUser(user.id, (tx) =>
        tx
          .select({
            id: schedules.id,
            status: schedules.status,
            rule: schedules.rule,
            watch: schedules.watch,
            checkedAt: watchState.checkedAt,
            changedAt: watchState.changedAt,
            failures: watchState.failures,
          })
          .from(schedules)
          .leftJoin(watchState, eq(watchState.scheduleId, schedules.id))
          .where(and(eq(schedules.kind, "watch")))
      )
    : []

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1">
          <span className="label-mono">{"// radar"}</span>
          <h1 className="text-2xl font-semibold tracking-tight">Radar</h1>
          <p className="text-[13px] text-muted-foreground">
            Deadlines with the words they came from. Reminders show here; phone-call
            reminders come with the voice assistant.
          </p>
        </header>

        {radar && (
          <section className="flex flex-col gap-3">
            <h2 className="text-[15px] font-semibold">Coming up</h2>
            {items.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                Nothing yet. Ask an agent to watch an official page, or tell it a date.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {items.map((o) => (
                  <li
                    key={o.id}
                    className="glass flex flex-col gap-2 rounded-[20px] px-4 py-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[14px] font-semibold">{o.title}</span>
                      <span className="font-mono text-[12.5px]">
                        {DAY.format(o.dueAt)}
                      </span>
                    </div>
                    <blockquote className="border-l-2 border-hairline pl-3 text-[13px] text-muted-foreground">
                      &ldquo;{o.quote}&rdquo;
                    </blockquote>
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-faint">
                      <span>
                        from {source(o.sourceKind, o.sourceRef)}, read{" "}
                        {READ.format(o.readAt)}
                      </span>
                      {!o.verified && (
                        <span className="rounded-full border border-betelgeuse/40 px-2 py-0.5 text-betelgeuse">
                          Not verified
                        </span>
                      )}
                      {o.status === "missed" && (
                        <span className="rounded-full border border-destructive/40 px-2 py-0.5 text-destructive">
                          missed
                        </span>
                      )}
                      {o.remindNow && (
                        <span className="rounded-full border border-rigel/40 px-2 py-0.5 text-rigel">
                          reminder
                        </span>
                      )}
                    </div>
                    <ObligationButtons id={o.id} missed={o.status === "missed"} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {watchers && (
          <section className="flex flex-col gap-3">
            <h2 className="text-[15px] font-semibold">Watchers</h2>
            {watched.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                No pages watched. An agent can watch one for you, with your OK first.
              </p>
            ) : (
              <ul className="flex flex-col divide-y rounded-xl border">
                {watched.map((w) => {
                  const rule = ruleSchema.safeParse(w.rule)
                  return (
                    <li key={w.id} className="flex flex-col gap-2 px-3 py-3">
                      <span className="truncate text-[13.5px]">{w.watch?.url}</span>
                      {w.watch?.condition && (
                        <span className="text-[12.5px] text-muted-foreground">
                          Tell me when: {w.watch.condition}
                        </span>
                      )}
                      <span className="font-mono text-[10.5px] text-faint">
                        {rule.success ? describeRule(rule.data) : "schedule"} · {w.status}
                        {w.checkedAt && ` · checked ${WHEN.format(w.checkedAt)}`}
                        {w.changedAt && ` · last change ${WHEN.format(w.changedAt)}`}
                        {(w.failures ?? 0) > 0 && ` · ${w.failures} failed checks`}
                      </span>
                      <ScheduleControls scheduleId={w.id} status={w.status} />
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
