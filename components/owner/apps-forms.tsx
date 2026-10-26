"use client"

import { startTransition, useActionState, useEffect, useRef } from "react"
import { useFormStatus } from "react-dom"

import {
  addServer,
  approveDrift,
  pinTool,
  setServerStatus,
  setToolStatus,
  updateServer,
} from "@/actions/owner-apps"
import type { OwnerState } from "@/actions/owner"
import { StateNotice } from "@/components/auth/auth-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

// The forms on /owner/apps (N7). Every control is 44 px tall and named; the
// actions re-check the role on the server.

type Action = (state: OwnerState, form: FormData) => Promise<OwnerState>

function Submit({
  children,
  label,
  variant = "secondary",
  busy = false,
}: {
  children: React.ReactNode
  label?: string
  variant?: "default" | "secondary" | "destructive" | "outline"
  busy?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending || busy}
      aria-label={label}
      className="min-h-11"
    >
      {(pending || busy) && <Spinner data-icon="inline-start" />}
      {children}
    </Button>
  )
}

// A form with many fields keeps what was typed when the action says no (React
// would clear it after every submit); it clears only after a success.
function useKeptForm(action: Action) {
  const [state, run, busy] = useActionState<OwnerState, FormData>(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.message) ref.current?.reset()
  }, [state])
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    startTransition(() => run(data))
  }
  return { state, busy, formProps: { ref, onSubmit } }
}

function Field({
  label,
  name,
  hint,
  defaultValue,
  required,
  mono,
}: {
  label: string
  name: string
  hint?: string
  defaultValue?: string
  required?: boolean
  mono?: boolean
}) {
  return (
    <label className="flex flex-col gap-1 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <Input
        name={name}
        defaultValue={defaultValue}
        required={required}
        className={mono ? "h-11 font-mono text-[12.5px]" : "h-11"}
      />
      {hint && <span className="text-[11.5px] text-faint">{hint}</span>}
    </label>
  )
}

function Area({
  label,
  name,
  hint,
  defaultValue,
  rows = 3,
}: {
  label: string
  name: string
  hint?: string
  defaultValue?: string
  rows?: number
}) {
  return (
    <label className="flex flex-col gap-1 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <Textarea
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        className="font-mono text-[12px]"
      />
      {hint && <span className="text-[11.5px] text-faint">{hint}</span>}
    </label>
  )
}

// One button that posts hidden fields: status changes, switch on/off, approve
function ActionButton({
  action,
  fields,
  label,
  name,
  variant,
}: {
  action: Action
  fields: Record<string, string>
  label: string
  // What a screen reader hears, e.g. "Pause Tracker"
  name: string
  variant?: "default" | "secondary" | "destructive" | "outline"
}) {
  const [state, run] = useActionState<OwnerState, FormData>(action, null)
  return (
    <form action={run} className="flex flex-col gap-1.5">
      {Object.entries(fields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <div>
        <Submit label={name} variant={variant}>
          {label}
        </Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}

export function ServerStatusButton({
  id,
  appName,
  status,
  label,
  variant,
}: {
  id: string
  appName: string
  status: "active" | "suspended" | "retired"
  label: string
  variant?: "default" | "secondary" | "destructive" | "outline"
}) {
  return (
    <ActionButton
      action={setServerStatus}
      fields={{ id, status }}
      label={label}
      name={`${label} ${appName}`}
      variant={variant}
    />
  )
}

export function ToolStatusButton({
  serverId,
  name,
  kriyaName,
  status,
}: {
  serverId: string
  name: string
  kriyaName: string
  status: "disabled" | "pinned"
}) {
  const label = status === "disabled" ? "Switch off" : "Switch on"
  return (
    <ActionButton
      action={setToolStatus}
      fields={{ serverId, name, status }}
      label={label}
      name={`${label} ${kriyaName}`}
    />
  )
}

export function ApproveDriftButton({
  serverId,
  name,
  kriyaName,
  seenHash,
}: {
  serverId: string
  name: string
  kriyaName: string
  seenHash: string
}) {
  return (
    <ActionButton
      action={approveDrift}
      fields={{ serverId, name, seenHash }}
      label="Approve new definition"
      name={`Approve the new definition of ${kriyaName}`}
      variant="default"
    />
  )
}

const AUTHS = [
  ["oauth_public", "OAuth, public client"],
  ["oauth_cimd", "OAuth, client metadata document"],
  ["oauth_confidential", "OAuth, confidential client"],
  ["none", "No sign-in (reads only)"],
] as const

export function AddServerForm() {
  const { state, busy, formProps } = useKeptForm(addServer)
  return (
    <form {...formProps} className="flex flex-col gap-3 rounded-xl border bg-surface p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Id" name="id" hint="2 to 12 lowercase letters" required mono />
        <Field label="Name" name="name" required />
        <Field label="MCP address (https)" name="url" required mono />
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted-foreground">Sign-in</span>
          <select
            name="auth"
            defaultValue="oauth_public"
            className="h-11 rounded-md border bg-background px-3"
          >
            {AUTHS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Field label="Client id" name="clientId" mono />
        <Field
          label="Secret's name"
          name="secretEnv"
          hint="Confidential only: the Render variable, KRIYA_MCP_…"
          mono
        />
        <Field label="Scopes" name="scopes" hint="Separated by spaces" mono />
        <Field
          label="Sign-in addresses"
          name="origins"
          hint="https origins of the authorization server, at most 4"
          mono
        />
      </div>
      <Area
        label="Review notes"
        name="review"
        hint="Source, terms, region, scopes (MCP_CONNECTIVITY §9)"
        rows={4}
      />
      <div>
        <Submit variant="default" busy={busy}>
          Add as a draft
        </Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}

export function EditServerForm({
  id,
  name,
  scopes,
  origins,
  review,
}: {
  id: string
  name: string
  scopes: string[]
  origins: string[]
  review: string | null
}) {
  const { state, busy, formProps } = useKeptForm(updateServer)
  return (
    <form {...formProps} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" defaultValue={name} required />
        <Field label="Scopes" name="scopes" defaultValue={scopes.join(" ")} mono />
        <Field
          label="Sign-in addresses"
          name="origins"
          defaultValue={origins.join(" ")}
          mono
        />
      </div>
      <Area label="Review notes" name="review" defaultValue={review ?? ""} rows={4} />
      <div>
        <Submit busy={busy}>Save</Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}

const RISKS = [
  ["R0", "R0, only reads"],
  ["R1", "R1"],
  ["R2", "R2, asks first"],
  ["R3", "R3, asks first"],
  ["R4", "R4, asks first"],
] as const

export function PinToolForm({ serverId }: { serverId: string }) {
  const { state, busy, formProps } = useKeptForm(pinTool)
  return (
    <form {...formProps} className="flex flex-col gap-3">
      <input type="hidden" name="serverId" value={serverId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="The app's name for the tool" name="name" required mono />
        <Field
          label="Kriya's name"
          name="kriyaName"
          hint={`mcp_${serverId}_… , 40 characters at most`}
          required
          mono
        />
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted-foreground">Risk you give it</span>
          <select
            name="ownerRisk"
            defaultValue="R4"
            className="h-11 rounded-md border bg-background px-3"
          >
            {RISKS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted-foreground">Never reaches an agent if it is</span>
          <select
            name="category"
            defaultValue=""
            className="h-11 rounded-md border bg-background px-3"
          >
            <option value="">None of these</option>
            <option value="payments">Payments</option>
            <option value="identity">Identity</option>
            <option value="credentials">Credentials</option>
            <option value="filing">Filing</option>
          </select>
        </label>
      </div>
      <Field
        label="What it does, in your words"
        name="description"
        hint="The model and the person read this, not the app's own text"
        required
      />
      <label className="flex min-h-11 items-center gap-2 text-[12.5px]">
        <input type="checkbox" name="idempotent" className="size-5" />
        Safe to repeat (reads only)
      </label>
      <Area
        label="Read-back (optional)"
        name="verify"
        hint='{"tool":"get_item","args":{"id":"/structuredContent/id"},"expect":{"/structuredContent/title":"/input/title"}}'
      />
      <Area
        label="Definition (optional)"
        name="definition"
        hint="Paste one tool's JSON from the app's own tool list if you can't sign in to it yet. Left empty, Kriya reads it as you."
        rows={5}
      />
      <div>
        <Submit variant="default" busy={busy}>
          Pin this tool
        </Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}
