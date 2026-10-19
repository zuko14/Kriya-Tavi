"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { changeGoal } from "@/actions/goals"
import { deleteRecord, verifyMyRecords } from "@/actions/inbox"
import { confirmMemory, forgetForGood } from "@/actions/memory"
import { setCap } from "@/actions/quotes"
import { changeSchedule } from "@/actions/schedules"
import { approveSkill, resetSkill, retireSkill } from "@/actions/skills"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// Buttons for the Inbox, the goal page and "What I did". Each one calls a
// server action (or the existing approvals route), shows a plain error if
// it fails, and refreshes the page's server data when it works.

// 44 px touch targets on phones (AGENTS.md)
const tap = "min-h-11 sm:min-h-8"

function useRun() {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const run = (work: () => Promise<{ error?: string } | unknown>) =>
    start(async () => {
      setError(null)
      try {
        const result = (await work()) as { error?: string } | undefined
        if (result?.error) setError(result.error)
        else router.refresh()
      } catch {
        setError("That didn't go through. Try again.")
      }
    })
  return { pending, error, setError, run }
}

const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-[12.5px] text-destructive">
      {error}
    </p>
  ) : null

export function ApprovalButtons({
  threadId,
  approvalId,
}: {
  threadId: string
  approvalId: string
}) {
  const { pending, error, run } = useRun()
  const answer = (approved: boolean) =>
    run(async () => {
      const response = await fetch(`/api/threads/${threadId}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId, approved }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        return { error: body?.error ?? "Couldn't record your answer." }
      }
    })
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button className={tap} disabled={pending} onClick={() => answer(true)}>
          Approve
        </Button>
        <Button
          className={tap}
          variant="outline"
          disabled={pending}
          onClick={() => answer(false)}
        >
          Decline
        </Button>
      </div>
      <Problem error={error} />
    </div>
  )
}

// Deleting can't be undone, so it takes a second tap
function useSecondTap() {
  const [armed, setArmed] = React.useState(false)
  React.useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4_000)
    return () => clearTimeout(timer)
  }, [armed])
  return { armed, arm: () => setArmed(true) }
}

export function MemoryButtons({ id }: { id: string }) {
  const { pending, error, run } = useRun()
  const { armed, arm } = useSecondTap()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button
          className={tap}
          disabled={pending}
          onClick={() => run(() => confirmMemory(id))}
        >
          Confirm
        </Button>
        <Button
          className={tap}
          variant="destructive"
          disabled={pending}
          onClick={() => (armed ? run(() => forgetForGood(id)) : arm())}
        >
          {armed ? "Tap again to delete" : "Delete"}
        </Button>
      </div>
      <Problem error={error} />
    </div>
  )
}

// A9: approve a draft skill or let a stuck one try again; retire either
export function SkillButtons({
  id,
  version,
  kind,
}: {
  id: string
  version: number
  kind: "draft" | "review"
}) {
  const { pending, error, run } = useRun()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button
          className={tap}
          disabled={pending}
          onClick={() =>
            run(() => (kind === "draft" ? approveSkill(id, version) : resetSkill(id)))
          }
        >
          {kind === "draft" ? "Approve" : "Try again"}
        </Button>
        <Button
          className={tap}
          variant="outline"
          disabled={pending}
          onClick={() => run(() => retireSkill(id))}
        >
          {kind === "draft" ? "Discard" : "Retire"}
        </Button>
      </div>
      <Problem error={error} />
    </div>
  )
}

type GoalStatus = "active" | "paused" | "achieved" | "abandoned"

export function GoalControls({ goalId, status }: { goalId: string; status: GoalStatus }) {
  const { pending, error, run } = useRun()
  const [override, setOverride] = React.useState(false)
  const change = (to: GoalStatus, force = false) =>
    run(async () => {
      const result = await changeGoal(goalId, to, force)
      if ("needsOverride" in result && result.needsOverride) setOverride(true)
      return result
    })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "active" && (
          <>
            <Button className={tap} disabled={pending} onClick={() => change("achieved")}>
              Close as achieved
            </Button>
            <Button
              className={tap}
              variant="outline"
              disabled={pending}
              onClick={() => change("paused")}
            >
              Pause
            </Button>
          </>
        )}
        {status === "paused" && (
          <Button className={tap} disabled={pending} onClick={() => change("active")}>
            Resume
          </Button>
        )}
        {status === "achieved" && (
          <Button
            className={tap}
            variant="outline"
            disabled={pending}
            onClick={() => change("active")}
          >
            Reopen
          </Button>
        )}
        {(status === "active" || status === "paused") && (
          <Button
            className={tap}
            variant="destructive"
            disabled={pending}
            onClick={() => change("abandoned")}
          >
            Abandon
          </Button>
        )}
      </div>
      <Problem error={error} />
      {override && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          It&apos;s your goal: you can close it anyway.
          <Button
            className={tap}
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => change("achieved", true)}
          >
            Close anyway
          </Button>
        </div>
      )}
    </div>
  )
}

export function ScheduleControls({
  scheduleId,
  status,
}: {
  scheduleId: string
  status: "active" | "paused" | "ended"
}) {
  const { pending, error, run } = useRun()
  const { armed, arm } = useSecondTap()
  if (status === "ended") return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {status === "active" ? (
          <Button
            size="sm"
            className={tap}
            variant="outline"
            disabled={pending}
            onClick={() => run(() => changeSchedule(scheduleId, "paused"))}
          >
            Pause
          </Button>
        ) : (
          <Button
            size="sm"
            className={tap}
            disabled={pending}
            onClick={() => run(() => changeSchedule(scheduleId, "active"))}
          >
            Resume
          </Button>
        )}
        <Button
          size="sm"
          className={tap}
          variant="destructive"
          disabled={pending}
          onClick={() => (armed ? run(() => changeSchedule(scheduleId, "ended")) : arm())}
        >
          {armed ? "Tap again to end" : "End"}
        </Button>
      </div>
      <Problem error={error} />
    </div>
  )
}

const rupees = new Intl.NumberFormat("en-IN")

export function CapForm({
  target,
  id,
  currentMicroInr,
  label,
}: {
  target: "schedule" | "goal"
  id: string
  currentMicroInr: number | null
  label: string
}) {
  const { pending, error, setError, run } = useRun()
  const [value, setValue] = React.useState(
    currentMicroInr ? String(Math.floor(currentMicroInr / 1_000_000)) : ""
  )
  const save = (event: React.FormEvent) => {
    event.preventDefault()
    const amount = value.replace(/[,\s₹]/g, "")
    if (amount && !/^\d+$/.test(amount)) return setError("Whole rupees only.")
    run(() => setCap(target, id, amount ? Number(amount) : null))
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-1.5">
      <label className="label-mono text-faint" htmlFor={`cap-${id}`}>
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px]">₹</span>
        <Input
          id={`cap-${id}`}
          inputMode="numeric"
          className={`w-32 ${tap}`}
          value={value}
          placeholder="No limit"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button size="sm" className={tap} type="submit" disabled={pending}>
          Save
        </Button>
        {currentMicroInr ? (
          <span className="text-[12px] text-muted-foreground">
            now ₹{rupees.format(Math.floor(currentMicroInr / 1_000_000))}
          </span>
        ) : null}
      </div>
      <Problem error={error} />
    </form>
  )
}

export function VerifyRecords() {
  const [pending, start] = React.useTransition()
  const [result, setResult] = React.useState<string | null>(null)
  const verify = () =>
    start(async () => {
      const chain = await verifyMyRecords().catch(() => null)
      if (!chain) return setResult("Couldn't check your records right now.")
      const gaps = chain.deleted.length
        ? ` ${chain.deleted.length} deleted by you (${chain.deleted.map((d) => `#${d.seq}`).join(", ")}).`
        : ""
      setResult(
        chain.ok
          ? `All ${chain.records} records intact.${gaps}`
          : `Record #${chain.firstMismatch} doesn't match its receipt.${gaps}`
      )
    })
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="ghost"
        className={tap}
        disabled={pending}
        onClick={verify}
      >
        Verify my records
      </Button>
      {result && <span role="status">{result}</span>}
    </span>
  )
}

export function DeleteRecord({ id, onDone }: { id: string; onDone?: () => void }) {
  const { pending, error, run } = useRun()
  const { armed, arm } = useSecondTap()
  const remove = async () => {
    const result = await deleteRecord(id)
    if (!("error" in result)) onDone?.()
    return result
  }
  return (
    <span className="flex items-center gap-2">
      <Button
        size="xs"
        variant="ghost"
        className={tap}
        disabled={pending}
        onClick={() => (armed ? run(remove) : arm())}
      >
        {armed ? "Tap again to delete this record" : "Delete record"}
      </Button>
      <Problem error={error} />
    </span>
  )
}
