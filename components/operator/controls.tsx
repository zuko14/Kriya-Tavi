"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CircleDashedIcon, MinusIcon } from "lucide-react"

import {
  approveMandate,
  closeMandate,
  confirmCriterion,
  declineMandate,
  mandateReportPdf,
  pauseMandate,
  resumeMandate,
  revokeGrant,
  revokeMandate,
  stopAllMandates,
  stopCrew,
} from "@/actions/mandates"
import { createShare } from "@/actions/share"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { MandateStatus, Pins } from "@/db/schema"
import { grantLine } from "@/lib/operator/labels"

// The person's controls on a job (O3, UX_SPEC §1–5). Each calls a server
// action, shows a plain error if it fails, and refreshes the page when it
// works. Copy says "job"; "mandate" is the internal word.

// 44 px touch targets on phones (AGENTS.md)
const tap = "min-h-11 sm:min-h-8"

function useRun() {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const run = (work: () => Promise<unknown>, then?: (result: never) => void) =>
    start(async () => {
      setError(null)
      try {
        const result = (await work()) as { error?: string } | undefined
        if (result?.error) setError(result.error)
        else if (then) then(result as never)
        else router.refresh()
      } catch {
        setError("That didn't go through. Try again.")
      }
    })
  return { pending, error, run, router }
}

const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-[12.5px] text-destructive">
      {error}
    </p>
  ) : null

export type ProposalView = {
  id: string
  title: string
  objective: string
  playbookId: string | null
  due: string
  checkIn: string
  budget: string | null
  quote: string
  criteria: { id: string; text: string; how: string }[]
  grants: { tool: string; pins: Pins; maxUses: number; why: string }[]
}

// A proposal, with reduce-only controls on each permission: lower its uses
// or turn it off. Nothing is granted until "Approve job".
export function MandateCard({ job }: { job: ProposalView }) {
  const { pending, error, run, router } = useRun()
  const [uses, setUses] = React.useState(job.grants.map((g) => g.maxUses))
  const [off, setOff] = React.useState<number[]>([])
  const edits = {
    drop: off,
    maxUses: Object.fromEntries(
      uses.flatMap((n, i) => (n < job.grants[i].maxUses ? [[String(i), n]] : []))
    ),
  }

  return (
    <li className="glass flex flex-col gap-3.5 rounded-[20px] px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-mono text-faint">
          Job proposal{job.playbookId ? ` · ${job.playbookId}` : ""}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {job.quote}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] leading-snug font-medium">{job.title}</h3>
        <p className="text-[13px] text-muted-foreground">{job.objective}</p>
        <span className="font-mono text-[11px] text-faint">
          Due {job.due} · checks in {job.checkIn}
          {job.budget ? ` · up to ${job.budget} a month` : ""}
        </span>
      </div>

      <section className="flex flex-col gap-1.5 border-t pt-3">
        <h4 className="label-mono">Done means</h4>
        <ul className="flex flex-col gap-1.5">
          {job.criteria.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-[13.5px]">
              <CircleDashedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                {c.text}{" "}
                <span className="text-[12px] text-muted-foreground">({c.how})</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 border-t pt-3">
        <h4 className="label-mono">Kriya may do without asking</h4>
        {job.grants.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Nothing: Kriya asks you before every action.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {job.grants.map((grant, i) => {
              const dropped = off.includes(i)
              const line = grantLine(grant.tool, grant.pins, uses[i])
              return (
                <li key={i} className="flex flex-col gap-1.5">
                  <span
                    className={
                      dropped
                        ? "text-[13.5px] break-words text-faint line-through"
                        : "text-[13.5px] break-words"
                    }
                  >
                    {line}
                  </span>
                  <span className="text-[12px] text-muted-foreground">{grant.why}</span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className={tap}
                      variant="outline"
                      aria-label={`One fewer: ${line}`}
                      disabled={pending || dropped || uses[i] <= 1}
                      onClick={() =>
                        setUses(uses.map((n, j) => (j === i ? Math.max(1, n - 1) : n)))
                      }
                    >
                      <MinusIcon className="size-3.5" /> Fewer
                    </Button>
                    <Button
                      className={tap}
                      variant="outline"
                      aria-pressed={dropped}
                      aria-label={`${dropped ? "Allow" : "Don't allow"}: ${line}`}
                      disabled={pending}
                      onClick={() =>
                        setOff(dropped ? off.filter((j) => j !== i) : [...off, i])
                      }
                    >
                      {dropped ? "Allow" : "Don't allow"}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t pt-3 text-[12.5px] text-muted-foreground">
        <p>
          Kriya will always ask you before calls, new recipients, posting anything or
          spending money.
        </p>
        <p>Kriya never pays, and never enters OTPs or passwords.</p>
      </section>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            className={tap}
            variant="outline"
            disabled={pending}
            onClick={() => run(() => declineMandate(job.id))}
          >
            Decline
          </Button>
          <Button
            className={tap}
            disabled={pending}
            onClick={() =>
              run(
                () => approveMandate(job.id, edits),
                (result: { goalId: string }) => router.push(`/goals/${result.goalId}`)
              )
            }
          >
            Approve job
          </Button>
        </div>
        <Problem error={error} />
      </div>
    </li>
  )
}

// Pause / Resume, Close and Revoke on the job panel
export function JobActions({ id, status }: { id: string; status: MandateStatus }) {
  const { pending, error, run } = useRun()
  const open = status === "active" || status === "needs_person" || status === "paused"
  if (!open) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {status === "active" ? (
          <Button
            className={tap}
            variant="outline"
            disabled={pending}
            onClick={() => run(() => pauseMandate(id))}
          >
            Pause
          </Button>
        ) : (
          <Button
            className={tap}
            disabled={pending}
            onClick={() => run(() => resumeMandate(id))}
          >
            Resume
          </Button>
        )}
        <Confirm
          trigger={
            <Button className={tap} variant="outline" disabled={pending}>
              Close job
            </Button>
          }
          title="Close this job?"
          description="Its permissions end and nothing more runs for it. What it already did stays in your records."
          action="Close job"
          onConfirm={() => run(() => closeMandate(id))}
        />
        <Confirm
          trigger={
            <Button className={tap} variant="destructive" disabled={pending}>
              Revoke job
            </Button>
          }
          title="Revoke this job?"
          description="Every permission it holds ends now and its schedules stop."
          action="Revoke"
          onConfirm={() => run(() => revokeMandate(id))}
        />
      </div>
      <Problem error={error} />
    </div>
  )
}

export function RevokeGrant({ id, label }: { id: string; label: string }) {
  const { pending, error, run } = useRun()
  return (
    <div className="flex flex-col gap-1">
      <Button
        className={tap}
        variant="outline"
        aria-label={`Revoke: ${label}`}
        disabled={pending}
        onClick={() => run(() => revokeGrant(id))}
      >
        Revoke
      </Button>
      <Problem error={error} />
    </div>
  )
}

// O11: every part's task stops; the job itself carries on
export function StopCrew({ id }: { id: string }) {
  const { pending, error, run } = useRun()
  return (
    <div className="flex flex-col gap-1">
      <Confirm
        trigger={
          <Button className={tap} variant="outline" disabled={pending}>
            Stop crew
          </Button>
        }
        title="Stop the crew?"
        description="Every member's part stops now. What they already did stays, and the job carries on."
        action="Stop crew"
        onConfirm={() => run(() => stopCrew(id))}
      />
      <Problem error={error} />
    </div>
  )
}

export function MarkDone({
  id,
  criterionId,
  text,
}: {
  id: string
  criterionId: string
  text: string
}) {
  const { pending, error, run } = useRun()
  return (
    <div className="flex flex-col gap-1">
      <Button
        className={tap}
        variant="outline"
        aria-label={`Mark done: ${text}`}
        disabled={pending}
        onClick={() => run(() => confirmCriterion(id, criterionId))}
      >
        Mark done
      </Button>
      <Problem error={error} />
    </div>
  )
}

export function StopAllJobs({ count }: { count: number }) {
  const { pending, error, run } = useRun()
  return (
    <div className="flex flex-col gap-1.5">
      <Confirm
        trigger={
          <Button className={tap} variant="destructive" disabled={pending || count === 0}>
            Stop all jobs
          </Button>
        }
        title="Stop every job?"
        description="Every running job is revoked now: its permissions end and its schedules stop. Proposals stay for you to decide."
        action="Stop all"
        onConfirm={() => run(() => stopAllMandates())}
      />
      <Problem error={error} />
    </div>
  )
}

// O5: the handover report as a PDF in the person's files
export function ReportButton({ id }: { id: string }) {
  const { pending, error, run } = useRun()
  const [fileId, setFileId] = React.useState<string | null>(null)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          className={tap}
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(
              () => mandateReportPdf(id),
              (result: { fileId: string }) => setFileId(result.fileId)
            )
          }
        >
          Make the report (PDF)
        </Button>
        {fileId && (
          <a
            href={`/api/files/${fileId}`}
            className="flex min-h-11 items-center text-[13px] font-medium text-rigel hover:underline sm:min-h-0"
          >
            Open the report
          </a>
        )}
      </div>
      <Problem error={error} />
    </div>
  )
}

const SHARE_DAYS = [1, 3, 7, 14, 30]

// O5 + K8: a completed job's report as a read-only link, shown once
export function ShareReport({ id }: { id: string }) {
  const [pending, start] = React.useTransition()
  const [open, setOpen] = React.useState(false)
  const [days, setDays] = React.useState(7)
  const [link, setLink] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const share = () =>
    start(async () => {
      setError(null)
      const result = await createShare("report", id, days).catch(() => ({
        error: "That didn't work. Try again.",
      }))
      if ("path" in result && result.path)
        setLink(`${window.location.origin}${result.path}`)
      else setError(("error" in result && result.error) || "That didn't work.")
    })
  return (
    <>
      <Button
        className={tap}
        variant="outline"
        onClick={() => {
          setLink(null)
          setError(null)
          setOpen(true)
        }}
      >
        Share the report
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{link ? "Your link" : "Share this job's report?"}</DialogTitle>
            <DialogDescription>
              {link
                ? "Copy it now: Kriya keeps only a fingerprint of it, so it can't be shown again."
                : "Anyone with the link can open a read-only PDF of this job's report: each done line, how it was proven, and what isn't confirmed. Nothing else from your account. You can revoke it in Account → Shared links."}
            </DialogDescription>
          </DialogHeader>
          {link ? (
            <code className="rounded-md border px-2 py-1.5 font-code text-[11px] break-all">
              {link}
            </code>
          ) : (
            <label className="flex flex-col gap-1 text-[13px]">
              Expires after
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="min-h-11 rounded-md border bg-transparent px-2"
              >
                {SHARE_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "1 day" : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Problem error={error} />
          {!link && (
            <DialogFooter>
              <Button className={tap} disabled={pending} onClick={share}>
                {pending
                  ? "Making the snapshot…"
                  : `Share for ${days === 1 ? "1 day" : `${days} days`}`}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
