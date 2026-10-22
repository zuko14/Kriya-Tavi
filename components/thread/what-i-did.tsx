"use client"

import * as React from "react"
import { CheckIcon, CircleHelpIcon, TriangleAlertIcon } from "lucide-react"

import { whatIDid, type WhatIDid } from "@/actions/inbox"
import { undoExecution, undoStatus } from "@/actions/undo"
import { Confirm } from "@/components/confirm"
import { DeleteRecord, VerifyRecords } from "@/components/inbox/controls"
import { ReceiptActions } from "@/components/thread/receipt-actions"
import { Button } from "@/components/ui/button"
import type { KriyaMessage } from "@/lib/agent/tools"
import { formatInr } from "@/lib/money"

// "What I did" under a reply (A3, UX_SPEC §4) and its receipt (K1). The
// lines come from the task's verified tool runs, never from the reply's
// words: ✓ only for actions that were checked, greyed "not confirmed" for
// the rest, and a warning on sentences whose quoted source didn't hold up.

export type WhatIDidRecord = WhatIDid["records"][number]

// O4: an action a job's standing grant allowed, without asking one by one
const UnderJob = ({ title }: { title?: string }) =>
  title ? (
    <span className="block w-full font-mono text-[10.5px] text-faint">
      under your job: {title}
    </span>
  ) : null

const UUID = /^[0-9a-f-]{36}$/

// One request per thread, once nothing is streaming. Returns nothing while
// agents.inbox is off (the action answers with no records).
export function useWhatIDid(messages: KriyaMessage[], busy: boolean) {
  const ids = [
    ...new Set(
      messages.flatMap((m) =>
        m.role === "assistant" && UUID.test(m.metadata?.taskId ?? "")
          ? [m.metadata!.taskId!]
          : []
      )
    ),
  ]
  const key = ids.join(",")
  const [data, setData] = React.useState<WhatIDid | null>(null)
  React.useEffect(() => {
    if (busy || !key) return
    let live = true
    whatIDid(key.split(",")).then(
      (result) => live && setData(result),
      () => {}
    )
    return () => {
      live = false
    }
  }, [key, busy])
  return data
}

const TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
})

const CHARGE: { [status: string]: string } = {
  final: "final",
  estimated: "estimated",
  unpriced: "price pending",
}

function Evidence({ kind, value }: { kind: string; value: string }) {
  if (kind === "url" && /^https:\/\//.test(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer noopener"
        className="rounded-full border px-2 py-0.5 font-mono text-[10px] text-rigel hover:underline"
      >
        open
      </a>
    )
  }
  return (
    <span className="rounded-full border px-2 py-0.5 font-mono text-[10px] text-faint">
      {kind === "file" ? "file" : `id …${value.slice(-6)}`}
    </span>
  )
}

type Undo = NonNullable<WhatIDidRecord["undo"]>[number]

const POLL_MS = 3_000

// K3: Undo for 10 minutes on actions with a reliable reverse. Actions
// without one have no undo record, so no button (AT-UNDO-03). The worker
// runs it; "undone" shows only after its read-back confirmed it.
function UndoControl({ initial }: { initial: Undo }) {
  const [undo, setUndo] = React.useState(initial)
  const [error, setError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(() => Date.parse(initial.until) > Date.now())

  // The window closes without a reload
  React.useEffect(() => {
    const left = Date.parse(undo.until) - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setOpen(false), left)
    return () => clearTimeout(timer)
  }, [undo.until])

  React.useEffect(() => {
    if (undo.state !== "queued") return
    const timer = setInterval(async () => {
      const next = await undoStatus(undo.executionId).catch(() => null)
      if (next && next.state !== "queued") setUndo(next)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [undo.state, undo.executionId])

  const chip = "rounded-full border px-2 py-0.5 font-mono text-[10px]"
  if (undo.state === "done")
    return (
      <span className={`${chip} text-ok`}>
        {undo.verb === "Close" ? "closed" : "undone"} ✓
      </span>
    )
  if (undo.state === "queued")
    return <span className={`${chip} text-faint`}>undoing…</span>
  if (undo.state === "failed")
    return (
      <span role="alert" className={`${chip} text-destructive`}>
        undo failed{undo.error ? `: ${undo.error}` : ""}
      </span>
    )
  if (undo.state !== "available" || !open) return null
  return (
    <>
      <Confirm
        trigger={
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
          >
            {undo.verb}
          </Button>
        }
        title={undo.verb === "Close" ? "Close this issue?" : "Undo this?"}
        description={undo.label}
        action={undo.verb}
        onConfirm={async () => {
          setError(null)
          const result = await undoExecution(undo.executionId).catch(() => ({
            error: "That didn't go through. Try again.",
          }))
          if ("error" in result && result.error) setError(result.error)
          else setUndo({ ...undo, state: "queued" })
        }}
      />
      {error && (
        <span role="alert" className="text-[11px] text-destructive">
          {error}
        </span>
      )}
    </>
  )
}

export function WhatIDidCard({
  record,
  receipts,
}: {
  record: WhatIDidRecord
  receipts: boolean
}) {
  const [gone, setGone] = React.useState(false)
  const unsupported = record.checks.filter((c) => c.status === "unsupported")
  if (record.deletedAt || gone) {
    return (
      <p className="pl-[30px] font-mono text-[10.5px] text-faint">
        Record #{record.seq} deleted by you.
      </p>
    )
  }
  if (!record.done.length && !record.unconfirmed.length && !unsupported.length)
    return null

  return (
    <section
      aria-label="What I did"
      className="ml-[30px] flex flex-col gap-2 rounded-2xl border border-hairline px-3.5 py-3"
    >
      <h3 className="label-mono text-faint">What I did</h3>
      <ul className="flex flex-col gap-1.5">
        {record.done.map((d) => (
          <li key={d.executionId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <CheckIcon className="size-3.5 shrink-0 text-ok" aria-label="checked" />
            <span className="text-[13px]">{d.title}</span>
            <span className="font-mono text-[10.5px] text-faint">
              {TIME.format(new Date(record.createdAt))}
            </span>
            {d.verification.evidence.map((e) => (
              <Evidence key={`${e.kind}:${e.value}`} kind={e.kind} value={e.value} />
            ))}
            {record.undo
              ?.filter((u) => u.executionId === d.executionId)
              .map((u) => (
                <UndoControl key={u.executionId} initial={u} />
              ))}
            <UnderJob title={record.jobs?.[d.executionId]} />
          </li>
        ))}
        {record.unconfirmed.map((u, i) => (
          <li key={`u${i}`} className="flex items-start gap-2 text-muted-foreground">
            <CircleHelpIcon
              className="mt-0.5 size-3.5 shrink-0"
              aria-label="not confirmed"
            />
            <span className="text-[13px]">
              {u.claim} <span className="text-faint">· not confirmed: {u.reason}</span>
              <UnderJob
                title={u.executionId ? record.jobs?.[u.executionId] : undefined}
              />
            </span>
          </li>
        ))}
        {unsupported.map((c, i) => (
          <li key={`c${i}`} className="flex items-start gap-2 text-betelgeuse">
            <TriangleAlertIcon
              className="mt-0.5 size-3.5 shrink-0"
              aria-label="unsupported"
            />
            <span className="text-[13px]">
              Unsupported: &ldquo;{c.sentence}&rdquo;{" "}
              <span className="text-faint">· {c.reason}</span>
            </span>
          </li>
        ))}
      </ul>
      {receipts && record.hash && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-faint">
          <span>
            record #{record.seq} · {record.hash.slice(0, 8)}
          </span>
          {record.chargeStatus && (
            <span>
              {formatInr(record.chargeMicroInr)} {CHARGE[record.chargeStatus]}
            </span>
          )}
          <VerifyRecords />
          {record.shareable && <ReceiptActions episodeId={record.id} seq={record.seq} />}
          <DeleteRecord id={record.id} onDone={() => setGone(true)} />
        </div>
      )}
    </section>
  )
}
