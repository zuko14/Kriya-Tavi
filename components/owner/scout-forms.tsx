"use client"

import { startTransition, useActionState, useEffect, useRef } from "react"
import { useFormStatus } from "react-dom"

import { addScoutSourceAction, setScoutSourceAction } from "@/actions/harness-evolve"
import type { OwnerState } from "@/actions/owner"
import { StateNotice } from "@/components/auth/auth-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

// The forms on /owner/harness (Harness 2.0 W7). Every control is 44 px tall
// and named; the actions re-check the role on the server.

function Submit({
  children,
  variant = "secondary",
  label,
}: {
  children: React.ReactNode
  variant?: "default" | "secondary" | "outline"
  label?: string
}) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      aria-label={label}
      className="min-h-11"
    >
      {pending && <Spinner data-icon="inline-start" />}
      {children}
    </Button>
  )
}

export function AddScoutSource({
  disciplines,
  kinds,
}: {
  disciplines: readonly string[]
  kinds: readonly string[]
}) {
  const [state, run] = useActionState<OwnerState, FormData>(addScoutSourceAction, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.message) ref.current?.reset()
  }, [state])
  return (
    <form
      ref={ref}
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        startTransition(() => run(data))
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted-foreground">
            Address (https, a page you have read)
          </span>
          <Input
            name="url"
            type="url"
            required
            placeholder="https://…"
            className="h-11 font-mono text-[12.5px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted-foreground">Discipline</span>
          <select
            name="discipline"
            defaultValue="frontend"
            className="h-11 rounded-md border bg-background px-3"
          >
            {disciplines.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted-foreground">Kind</span>
          <select
            name="kind"
            defaultValue="changelog"
            className="h-11 rounded-md border bg-background px-3"
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Submit variant="default">Add source</Submit>
        <StateNotice state={state} />
      </div>
    </form>
  )
}

export function ScoutSourceToggle({ id, active }: { id: string; active: boolean }) {
  const [state, run] = useActionState<OwnerState, FormData>(setScoutSourceAction, null)
  return (
    <form action={run} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? "off" : "on"} />
      <Submit
        variant="outline"
        label={active ? "Pause this source" : "Resume this source"}
      >
        {active ? "Pause" : "Resume"}
      </Submit>
      {state?.error && <StateNotice state={state} />}
    </form>
  )
}
