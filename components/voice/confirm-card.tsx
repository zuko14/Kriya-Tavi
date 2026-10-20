"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Volume2Icon } from "lucide-react"

import { confirmVoiceCall, declineVoiceCall } from "@/actions/voice"
import { Button } from "@/components/ui/button"

// The confirmation card (UX_AND_INTERACTION_SPEC §3, §11.3). It shows only
// what the server put in the approval (ConfirmationPayload), never client
// state, and confirming sends that approval's hash: if anything changed the
// server answers stale_approval and the card is reloaded. The full number
// must be shown once before "Confirm & call" works.

type Window = { from: string; to: string }
type Payload = {
  recipientLabel?: string
  recipientName?: string | null
  phone?: string
  goal?:
    | { type: "schedule_meeting"; date: string; preferred: string; acceptable: Window[] }
    | { type: "deliver_message"; message: string }
    | { type: "ask_question"; question: string }
  authority?: { mayAcceptWithinAcceptable?: boolean }
  mustNot?: string[]
  disclosure?: string
  earliestCallAt?: string
  reportAt?: string | null
  timezone?: string
  cost?: string
}

export type ConfirmApproval = {
  id: string
  payload: Record<string, unknown>
  payloadHash: string
  expiresAt: string
}

const tap = "min-h-11"

// "+91 98xxx xxx10"; the whole number only when asked
const masked = (e164 = "") => {
  const d = e164.replace(/^\+91/, "")
  return d.length === 10 ? `+91 ${d.slice(0, 2)}xxx xxx${d.slice(8)}` : e164
}
const spaced = (e164 = "") => {
  const d = e164.replace(/^\+91/, "")
  return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : e164
}

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`
}
const day = (ymd: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(new Date(`${ymd}T00:00:00Z`))
    .replace(",", "")
const at = (iso: string, timeZone = "Asia/Kolkata") =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso))

function ask(goal: NonNullable<Payload["goal"]>) {
  if (goal.type === "schedule_meeting") {
    return `meet on ${day(goal.date)} at ${clock(goal.preferred)}`
  }
  if (goal.type === "deliver_message") return `pass on: "${goal.message}"`
  return `ask: "${goal.question}"`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label-mono text-faint">{label}</span>
      <span className="text-[13.5px] leading-snug break-words">{children}</span>
    </div>
  )
}

export function ConfirmCard({ approval }: { taskId: string; approval: ConfirmApproval }) {
  const router = useRouter()
  const p = approval.payload as Payload
  const [shown, setShown] = React.useState(false)
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const [left, setLeft] = React.useState<number | null>(null)

  React.useEffect(() => {
    const tick = () =>
      setLeft(
        Math.max(0, Math.round((Date.parse(approval.expiresAt) - Date.now()) / 1000))
      )
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [approval.expiresAt])

  const goal = p.goal
  const windows =
    goal?.type === "schedule_meeting" && p.authority?.mayAcceptWithinAcceptable
      ? goal.acceptable.map((w) => `${clock(w.from)}–${clock(w.to)}`).join(", ")
      : null

  const confirm = () =>
    start(async () => {
      setError(null)
      const result = await confirmVoiceCall(approval.id, approval.payloadHash)
      if (result.ok) {
        // A small tap on phones that have it; never needed
        navigator.vibrate?.(12)
        router.refresh()
      } else {
        setError(result.message)
        if (result.code === "stale_approval" || result.code === "expired")
          router.refresh()
      }
    })
  const edit = () =>
    start(async () => {
      const result = await declineVoiceCall(approval.id)
      if (!result.ok) setError(result.message)
      router.refresh()
    })
  // The exact opening, in the browser's own voice; only on tap (§11.3)
  const listen = () => {
    if (!p.disclosure || !("speechSynthesis" in window)) return
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(p.disclosure))
  }

  return (
    <section
      aria-label="Confirm the call"
      className="glass-strong rise flex flex-col gap-4 rounded-[24px] px-4 py-5 sm:px-5"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid size-11 shrink-0 place-items-center rounded-full bg-rigel-soft font-display text-[20px] text-rigel"
        >
          {(p.recipientLabel ?? "?")
            .replace(/^my\s+/i, "")
            .charAt(0)
            .toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="label-mono text-faint">Call</span>
          <span className="text-[15px] font-medium break-words">
            {p.recipientLabel}
            {p.recipientName ? ` (${p.recipientName})` : ""}
          </span>
        </div>
        {left !== null && (
          <span className="label-mono shrink-0 text-faint tabular-nums">
            {left > 0
              ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`
              : "expired"}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[15px] tracking-wide tabular-nums">
          {shown ? spaced(p.phone) : masked(p.phone)}
        </span>
        {!shown && (
          <Button variant="outline" className={tap} onClick={() => setShown(true)}>
            Show all
          </Button>
        )}
      </div>

      <Row label="Tavi will say">
        <q className="font-display text-[16px] leading-snug italic">{p.disclosure}</q>
      </Row>
      {goal && <Row label="Ask">{ask(goal)}</Row>}
      {windows && <Row label="May agree to">{windows} that day</Row>}
      <Row label="Won't">
        {["share your number", "agree to anything else", ...(p.mustNot ?? [])].join("; ")}
      </Row>
      {p.earliestCallAt && (
        <Row label="When">
          Calls from {at(p.earliestCallAt, p.timezone)}, between 9 AM and 9 PM
        </Row>
      )}
      <Row label="Result">
        {p.reportAt
          ? `Tavi calls you with it at ${at(p.reportAt, p.timezone)}`
          : "Shown here when the call is done"}
      </Row>
      <Row label="Cost">{p.cost}</Row>

      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className={tap} onClick={listen}>
          <Volume2Icon data-icon="inline-start" />
          Listen to the opening
        </Button>
        <span className="flex-1" />
        {/* Back to the draft; field editing comes with updateDraft */}
        <Button variant="outline" className={tap} disabled={pending} onClick={edit}>
          Not yet
        </Button>
        <button
          type="button"
          disabled={!shown || pending || left === 0}
          onClick={confirm}
          className="btn-liquid min-h-11 rounded-full px-5 text-[14px] font-medium"
        >
          Confirm &amp; call
        </button>
      </div>
      {!shown && (
        <p className="text-[12px] text-muted-foreground">
          Check the full number before confirming.
        </p>
      )}
    </section>
  )
}
