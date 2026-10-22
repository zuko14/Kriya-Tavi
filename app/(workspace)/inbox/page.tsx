import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import { ChevronRightIcon } from "lucide-react"

import { Glyph } from "@/components/glyph"
import { ApprovalButtons, MemoryButtons, SkillButtons } from "@/components/inbox/controls"
import { MandateCard } from "@/components/operator/controls"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { evidenceLabel } from "@/lib/operator/labels"
import { formatInr } from "@/lib/money"
import { quoteFor } from "@/lib/quotes"
import { cn } from "@/lib/utils"
import { getInbox, type Inbox } from "@/queries/inbox"

export const metadata: Metadata = { title: "Inbox" }

// What's waiting for the person (A3, UX_SPEC §3): approvals, questions from
// background runs, and notes to review. Live without polling: the notifier
// refreshes the page when a task finishes.

const FILTERS = [
  { id: "all", label: "All" },
  { id: "approve", label: "Approve" },
  { id: "answer", label: "Answer" },
  { id: "memories", label: "Memories" },
] as const
type Filter = (typeof FILTERS)[number]["id"]

// What approving actually does, in the person's words
function riskLabel(tool: string, risk: string) {
  if (tool.startsWith("schedule_")) return "Starts a scheduled job"
  if (tool === "calendar_create_event") return "Will save to your calendar"
  if (tool === "gmail_draft") return "Will save a draft in Gmail"
  return risk === "R4"
    ? "Will act publicly"
    : risk === "R3"
      ? "Will change your account"
      : "Needs your OK"
}

type Preview = {
  cadence?: string
  nextRuns?: string[]
  runsPerMonth?: number
  note?: string
  input?: Record<string, unknown>
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <li className="glass flex flex-col gap-3 rounded-[20px] px-4 py-4">{children}</li>
  )
}

function Approval({ item }: { item: Inbox["approvals"][number] }) {
  const preview = (item.preview ?? {}) as Preview
  return (
    <Card>
      <div className="flex items-center gap-2">
        {item.agentGlyph && <Glyph seed={item.agentGlyph} className="size-6" />}
        <span className="text-[13px] font-semibold">
          {item.agentName ?? "Your agent"}
        </span>
        <span className="ml-auto rounded-full bg-betelgeuse/15 px-2 py-0.5 font-mono text-[10.5px] text-betelgeuse">
          {riskLabel(item.toolName, item.riskClass)}
        </span>
      </div>
      {item.jobTitle && (
        <p className="text-[12.5px] text-muted-foreground">
          for job: {item.jobTitle} · {item.agentName ?? "Your agent"}
        </p>
      )}
      <h3 className="text-[14.5px] leading-snug font-medium">{item.title}</h3>
      {preview.cadence && (
        <div className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
          <span>
            {preview.cadence}, about {preview.runsPerMonth} runs a month.
          </span>
          {preview.nextRuns?.length ? (
            <span>Next: {preview.nextRuns.join(" · ")}</span>
          ) : null}
          {preview.note && <span>{preview.note}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <ApprovalButtons threadId={item.threadId} approvalId={item.id} />
        <div className="flex flex-col items-end gap-0.5 font-mono text-[11px] text-faint">
          <span>
            expires {formatDistanceToNowStrict(item.expiresAt, { addSuffix: true })}
          </span>
          <Link
            href={item.href}
            className="flex min-h-11 items-center gap-0.5 text-muted-foreground hover:text-foreground sm:min-h-0"
          >
            Open thread <ChevronRightIcon className="size-3.5" />
          </Link>
        </div>
      </div>
    </Card>
  )
}

// A skill's highest step, in the person's words (UX_SPEC §11)
const SKILL_RISK: Record<string, string> = {
  R4: "Acts publicly — asks you each time",
  R3: "Changes your accounts — asks you each time",
  R2: "Asks you each time it commits",
  R1: "Reads, and keeps notes",
  R0: "Reads only",
}

function Skill({ skill }: { skill: Inbox["skills"][number] }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-mono text-faint">
          {skill.kind === "draft" ? `New skill · v${skill.version}` : "Stopped matching"}
        </span>
        <span className="ml-auto rounded-full bg-betelgeuse/15 px-2 py-0.5 font-mono text-[10.5px] text-betelgeuse">
          {SKILL_RISK[skill.maxRisk]}
        </span>
      </div>
      <h3 className="text-[14.5px] leading-snug font-medium">{skill.name}</h3>
      {skill.description && (
        <p className="text-[13px] text-muted-foreground">{skill.description}</p>
      )}
      {skill.kind === "review" && (
        <p className="text-[13px] text-muted-foreground">
          Twice in a row the page or account no longer matched these steps, so your agents
          do the work themselves until you say to try the skill again.
        </p>
      )}
      <ol className="flex list-decimal flex-col gap-1 pl-5 font-mono text-[11.5px] break-words text-muted-foreground">
        {skill.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {(skill.slots.length > 0 || skill.site) && (
        <p className="text-[12.5px] text-muted-foreground">
          {skill.slots.length > 0 &&
            `Fills in: ${skill.slots.map((s) => s.description).join(", ")}. `}
          {skill.site && `Site: ${skill.site}.`}
        </p>
      )}
      <SkillButtons id={skill.id} version={skill.version} kind={skill.kind} />
    </Card>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-1">
        <h2 className="label-mono">{title}</h2>
        <span className="font-mono text-[10px] text-faint tabular-nums">{count}</span>
      </div>
      <ul className="flex flex-col gap-2.5">{children}</ul>
    </section>
  )
}

const DAY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
})

// O3: a proposal as the card shows it, with its quote (K2) or none
async function proposalView(
  userId: string,
  job: NonNullable<Inbox["jobs"]>["review"][number]
) {
  const quote = job.playbookId
    ? await quoteFor(userId, { workflowId: job.playbookId })
    : null
  return {
    id: job.id,
    title: job.title,
    objective: job.objective,
    playbookId: job.playbookId,
    due: DAY.format(job.dueAt),
    checkIn: job.checkIn,
    budget: job.budgetMicroInr ? formatInr(job.budgetMicroInr) : null,
    quote: quote ? `₹ ~${formatInr(quote.p50MicroInr)} a run` : "No estimate yet",
    criteria: job.criteria.map((c) => ({
      id: c.id,
      text: c.text,
      how: evidenceLabel(c.evidence),
    })),
    grants: job.grants,
  }
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>
}) {
  const user = await requireUser()
  if ((await getSetting("agents.inbox")) !== "on") notFound()
  const { show } = await searchParams
  const filter: Filter = FILTERS.some((f) => f.id === show) ? (show as Filter) : "all"
  const inbox = await getInbox(user.id)
  const shown = (what: Filter) => filter === "all" || filter === what
  const jobs = inbox.jobs
  const proposals = jobs
    ? await Promise.all(jobs.review.map((job) => proposalView(user.id, job)))
    : []
  const total =
    inbox.approvals.length +
    inbox.questions.length +
    inbox.memories.length +
    inbox.skills.length +
    proposals.length +
    (jobs?.needs.length ?? 0)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
            Inbox
          </h1>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            What your agents are waiting on: actions to approve, questions to answer and
            notes to check. Nothing happens until you say so.
          </p>
        </header>

        {inbox.googleStopped.length > 0 && (
          <Link
            href="/account#connections"
            className="flex min-h-11 flex-col justify-center gap-0.5 rounded-xl border border-betelgeuse/40 bg-betelgeuse/10 px-3.5 py-2.5 text-[13px]"
          >
            <span className="font-medium text-betelgeuse">
              Google stopped working: reconnect to keep your jobs running
            </span>
            <span className="text-muted-foreground">
              {inbox.googleStopped.join(" · ")}
            </span>
          </Link>
        )}

        {jobs && (
          <Link
            href="/settings"
            className="flex min-h-11 w-fit items-center gap-1 text-[13px] font-medium text-rigel sm:min-h-0"
          >
            Your jobs, and Stop all <ChevronRightIcon className="size-3.5" />
          </Link>
        )}

        <nav
          aria-label="Filter"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0"
        >
          {FILTERS.map((f) => (
            <Link
              key={f.id}
              href={f.id === "all" ? "/inbox" : `/inbox?show=${f.id}`}
              aria-current={filter === f.id ? "page" : undefined}
              className={cn(
                "flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-[12.5px] sm:min-h-8",
                filter === f.id
                  ? "border-rigel bg-rigel-soft text-rigel"
                  : "text-muted-foreground"
              )}
            >
              {f.label}
            </Link>
          ))}
        </nav>

        {total === 0 ? (
          <p className="glass rounded-[20px] px-4 py-6 text-center text-[13.5px] text-muted-foreground">
            Nothing is waiting for you.
          </p>
        ) : (
          <>
            {shown("approve") && (
              <Section title="Jobs to review" count={proposals.length}>
                {proposals.map((job) => (
                  <MandateCard key={job.id} job={job} />
                ))}
              </Section>
            )}
            {shown("answer") && jobs && (
              <Section title="Jobs that need you" count={jobs.needs.length}>
                {jobs.needs.map((job) => (
                  <Card key={job.id}>
                    <span className="label-mono text-betelgeuse">Needs you</span>
                    <h3 className="text-[14.5px] leading-snug font-medium">
                      {job.title}
                    </h3>
                    {job.reason && (
                      <p className="text-[13px] text-muted-foreground">{job.reason}</p>
                    )}
                    {job.goalId && (
                      <Link
                        href={`/goals/${job.goalId}`}
                        className="flex min-h-11 w-fit items-center gap-1 text-[13px] font-medium text-rigel sm:min-h-0"
                      >
                        Open the job <ChevronRightIcon className="size-3.5" />
                      </Link>
                    )}
                  </Card>
                ))}
              </Section>
            )}
            {shown("approve") && (
              <Section title="Approve" count={inbox.approvals.length}>
                {inbox.approvals.map((item) => (
                  <Approval key={`${item.threadId}:${item.id}`} item={item} />
                ))}
              </Section>
            )}
            {shown("approve") && (
              <Section title="Skills" count={inbox.skills.length}>
                {inbox.skills.map((skill) => (
                  <Skill key={`${skill.id}:${skill.version}`} skill={skill} />
                ))}
              </Section>
            )}
            {shown("answer") && (
              <Section title="Needs your answer" count={inbox.questions.length}>
                {inbox.questions.map((q) => (
                  <Card key={q.threadId}>
                    <span className="label-mono text-faint">
                      {q.threadTitle ?? "Scheduled run"} ·{" "}
                      {formatDistanceToNowStrict(q.askedAt, { addSuffix: true })}
                    </span>
                    <p className="text-[14.5px] leading-snug">{q.question}</p>
                    <Link
                      href={q.href}
                      className="flex min-h-11 w-fit items-center gap-1 text-[13px] font-medium text-rigel sm:min-h-0"
                    >
                      Answer in the thread <ChevronRightIcon className="size-3.5" />
                    </Link>
                  </Card>
                ))}
              </Section>
            )}
            {shown("memories") && (
              <Section title="Memories to review" count={inbox.memories.length}>
                {inbox.memories.map((note) => (
                  <Card key={note.id}>
                    <p className="text-[14px] leading-snug">{note.content}</p>
                    <span className="label-mono text-faint">
                      {note.kind} · {note.agentName ?? "about you"} · saved while reading
                      outside content
                    </span>
                    <MemoryButtons id={note.id} />
                  </Card>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
