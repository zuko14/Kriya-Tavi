import Link from "next/link"
import { CheckIcon, ChevronRightIcon, CircleDashedIcon } from "lucide-react"

import {
  JobActions,
  MarkDone,
  ReportButton,
  RevokeGrant,
  ShareReport,
  StopCrew,
} from "@/components/operator/controls"
import { evidenceLabel, grantLine, STATUS_LABEL } from "@/lib/operator/labels"
import { cn } from "@/lib/utils"
import type { JobView } from "@/queries/mandates"

// The job on its goal's page (O3, UX_SPEC §2): status, what it needs from
// the person, what done means, the authority it holds, and the controls.

// O11: a crew part as the person reads it (CREW_EXECUTION §7)
const PART_STATUS: Record<string, string> = {
  waiting: "Waiting for another part",
  queued: "Starting",
  working: "Working",
  needs_approval: "Needs your approval",
  done: "Done",
  failed: "Failed",
  canceled: "Stopped",
}

const DAY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
})
const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
})

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <h3 className="label-mono">{title}</h3>
      {children}
    </div>
  )
}

export function JobPanel({ view }: { view: JobView }) {
  const { job } = view
  const needsYou = job.status === "needs_person"
  return (
    <section
      aria-label="Job"
      className="glass flex flex-col gap-3 rounded-[20px] px-4 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-mono text-faint">Job</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-mono text-[11px]",
            needsYou ? "bg-betelgeuse/15 text-betelgeuse" : "bg-rigel-soft text-rigel"
          )}
        >
          {/* A person's tick is never "verified" (OD-05) */}
          {job.status === "completed" && job.verdict?.some((r) => r.by === "person")
            ? "Done"
            : STATUS_LABEL[job.status]}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          due {DAY.format(job.dueAt)}
        </span>
      </div>

      {(view.waiting > 0 || job.statusReason) && (
        <Part title="Needs from you">
          {job.statusReason && <p className="text-[13.5px]">{job.statusReason}</p>}
          {view.waiting > 0 && (
            <Link
              href="/inbox?show=approve"
              className="flex min-h-11 w-fit items-center gap-1 text-[13px] font-medium text-rigel sm:min-h-0"
            >
              {view.waiting} {view.waiting === 1 ? "action waits" : "actions wait"} for
              your approval <ChevronRightIcon className="size-3.5" />
            </Link>
          )}
        </Part>
      )}

      <Part title="Done means">
        <ul className="flex flex-col gap-2">
          {job.criteria.map((c) => {
            const ticked = job.confirmed.includes(c.id)
            const checked = view.checked?.[c.id]
            const met =
              ticked ||
              (checked
                ? checked.met
                : Boolean(job.verdict?.find((v) => v.id === c.id)?.met))
            const Icon = met ? CheckIcon : CircleDashedIcon
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    met ? "text-ok" : "text-muted-foreground"
                  )}
                  aria-label={met ? "met" : "not yet"}
                />
                <span className="flex-1 text-[13.5px]">
                  {c.text}{" "}
                  <span className="text-[12px] text-muted-foreground">
                    (
                    {ticked
                      ? "confirmed by you"
                      : checked
                        ? `${evidenceLabel(c.evidence)} · ${checked.line}`
                        : evidenceLabel(c.evidence)}
                    )
                  </span>
                </span>
                {c.evidence.kind === "person_confirmed" && !ticked && (
                  <MarkDone id={job.id} criterionId={c.id} text={c.text} />
                )}
              </li>
            )
          })}
        </ul>
      </Part>

      <Part title="Authority">
        {view.grants.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            None: Kriya asks you before every action.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {view.grants.map((grant) => {
              const line = grantLine(grant.tool, grant.pins, grant.maxUses)
              return (
                <li key={grant.id} className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 text-[13.5px] break-words">
                    {line}
                    <span className="block font-mono text-[11px] text-faint">
                      used {grant.uses} of {grant.maxUses} ·{" "}
                      {grant.status === "active"
                        ? `until ${DAY.format(grant.expiresAt)}`
                        : grant.status}
                    </span>
                  </span>
                  {grant.status === "active" && (
                    <RevokeGrant id={grant.id} label={line} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Part>

      {view.crew && (
        <Part title={`Crew · round ${view.crew.round}`}>
          <ul className="flex flex-col gap-1">
            {view.crew.parts.map((p) => (
              <li key={p.key}>
                <Link
                  href={`/a/${p.agentId}/${p.threadId}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-2 text-[13.5px] sm:min-h-0"
                >
                  <span className="font-medium text-rigel">
                    {p.name ?? "A member"} · {p.key}
                  </span>
                  <span
                    className={cn(
                      "text-[12px]",
                      p.status === "needs_approval"
                        ? "text-betelgeuse"
                        : "text-muted-foreground"
                    )}
                  >
                    {PART_STATUS[p.status]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {(view.crew.status === "running" || view.crew.status === "joining") && (
            <StopCrew id={job.id} />
          )}
        </Part>
      )}

      <Part title="Activity">
        <span className="text-[13px] text-muted-foreground">
          {["active", "needs_person", "paused"].includes(job.status)
            ? `Checks in ${view.checkIn}${view.nextCheckIn ? ` · next ${IST.format(view.nextCheckIn)}` : ""}`
            : "No more check-ins: the job has ended."}
        </span>
      </Part>

      <JobActions id={job.id} status={job.status} />
      {view.reports && (
        <div className="flex flex-wrap gap-2">
          <ReportButton id={job.id} />
          {job.status === "completed" && <ShareReport id={job.id} />}
        </div>
      )}
    </section>
  )
}
