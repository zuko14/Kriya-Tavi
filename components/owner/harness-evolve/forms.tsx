"use client"

import { startTransition, useActionState, useMemo } from "react"
import { useFormStatus } from "react-dom"

import {
  benchCandidateAction,
  decideCandidateAction,
  freezeScoutAction,
  versionAction,
} from "@/actions/harness-evolve"
import type { OwnerState } from "@/actions/owner"
import { StateNotice } from "@/components/auth/auth-kit"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Harness 2.0 W9: the proposal page's controls (SELF_EVOLUTION §4). Every
// control is 44 px tall and named; the actions re-check the role on the
// server, and none sends a verdict or a status.

function Submit({
  children,
  variant = "secondary",
  name,
  value,
}: {
  children: React.ReactNode
  variant?: "default" | "secondary" | "outline" | "destructive"
  name?: string
  value?: string
}) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      name={name}
      value={value}
      className="min-h-11"
    >
      {pending && <Spinner data-icon="inline-start" />}
      {children}
    </Button>
  )
}

const submitWith =
  (run: (data: FormData) => void) => (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(
      event.currentTarget,
      (event.nativeEvent as SubmitEvent).submitter
    )
    startTransition(() => run(data))
  }

/** The candidate as a file, for `--cartridge-candidate` on the owner's machine. */
export function CandidateDownload({ file, name }: { file: unknown; name: string }) {
  const href = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2) + "\n"], { type: "application/json" })
      ),
    [file]
  )
  return (
    <Button
      nativeButton={false}
      variant="outline"
      className="min-h-11 self-start"
      render={<a href={href} download={name} />}
    >
      Download {name}
    </Button>
  )
}

const fileInput =
  "min-h-11 rounded-md border bg-background px-3 py-2 text-[13px] file:mr-3 file:border-0 file:bg-transparent file:text-[13px]"

export function BenchUpload({ id }: { id: string }) {
  const [state, run] = useActionState<OwnerState, FormData>(benchCandidateAction, null)
  return (
    <form onSubmit={submitWith(run)} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <label className="flex flex-col gap-1 text-[13px]">
        Incumbent reports (run without the candidate)
        <input
          className={fileInput}
          type="file"
          name="incumbent"
          accept="application/json,.json"
          multiple
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        Candidate reports (run with --cartridge-candidate), in the same order
        <input
          className={fileInput}
          type="file"
          name="candidate"
          accept="application/json,.json"
          multiple
          required
        />
      </label>
      <Submit>Upload and compute the verdict</Submit>
      <StateNotice state={state} />
    </form>
  )
}

export function DecideCandidate({ id, held }: { id: string; held: boolean }) {
  const [state, run] = useActionState<OwnerState, FormData>(decideCandidateAction, null)
  return (
    <form onSubmit={submitWith(run)} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <label className="flex flex-col gap-1 text-[13px]">
        {held
          ? "Reason (required to approve a held candidate, 10 characters or more)"
          : "Reason (optional)"}
        <textarea
          name="reason"
          maxLength={500}
          rows={3}
          className="min-h-11 rounded-md border bg-background px-3 py-2 text-[13px]"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Submit variant="default" name="decision" value="approve">
          {held ? "Approve with this reason" : "Approve"}
        </Submit>
        <Submit variant="outline" name="decision" value="reject">
          Reject
        </Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}

export function FreezeScout() {
  const [state, run] = useActionState<OwnerState, FormData>(freezeScoutAction, null)
  return (
    <form onSubmit={submitWith(run)} className="flex flex-col gap-2">
      <Submit variant="outline">Freeze the Scout</Submit>
      <StateNotice state={state} />
    </form>
  )
}

/** A version's next steps: canary 10 → 50 → 100 %, promote, roll back (W11). */
export function VersionControls({
  id,
  status,
  canaryPct,
}: {
  id: string
  status: string
  canaryPct: number
}) {
  const [state, run] = useActionState<OwnerState, FormData>(versionAction, null)
  const next = [10, 50, 100].filter(
    (p) => status === "approved" || (status === "canary" && p > canaryPct)
  )
  const servable = status === "approved" || status === "canary"
  return (
    <form onSubmit={submitWith(run)} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap gap-2">
        {next.map((p) => (
          <Submit key={p} name="op" value={`canary-${p}`}>
            Canary {p}%
          </Submit>
        ))}
        {servable && (
          <Submit variant="default" name="op" value="promote">
            Promote
          </Submit>
        )}
        {status !== "rolled_back" && status !== "superseded" && (
          <Submit variant="outline" name="op" value="rollback">
            Roll back
          </Submit>
        )}
      </div>
      <StateNotice state={state} />
    </form>
  )
}
