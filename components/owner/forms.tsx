"use client"

import { useActionState } from "react"
import { useFormStatus } from "react-dom"

import {
  addModel,
  reconcileUsage,
  refreshCatalogue,
  retryTask,
  saveSetting,
  savePlan,
  setModelEnabled,
  setUserStatus,
  type OwnerState,
} from "@/actions/owner"
import { StateNotice } from "@/components/auth/auth-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { Plan } from "@/db/schema"
import { TIER_LABELS, TIERS } from "@/lib/tiers"

function Submit({
  children,
  variant = "secondary",
}: {
  children: React.ReactNode
  variant?: "default" | "secondary" | "destructive" | "outline"
}) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending && <Spinner data-icon="inline-start" />}
      {children}
    </Button>
  )
}

export function UserStatusForm({ userId, status }: { userId: string; status: string }) {
  const [state, action] = useActionState<OwnerState, FormData>(setUserStatus, null)
  const suspending = status !== "suspended"
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="status" value={suspending ? "suspended" : "active"} />
      {suspending && (
        <Input
          name="reason"
          placeholder="Reason (kept in the audit log)"
          maxLength={500}
          required
        />
      )}
      <div>
        <Submit variant={suspending ? "destructive" : "default"}>
          {suspending ? "Suspend account" : "Reactivate account"}
        </Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}

export function SettingForm({
  settingKey,
  value,
  source,
  hint,
  env,
}: {
  settingKey: string
  value: string | null
  source: string | null
  hint: string | null
  env: string | null
}) {
  const [state, action] = useActionState<OwnerState, FormData>(saveSetting, null)
  return (
    <form action={action} className="flex flex-col gap-1.5 py-3">
      <input type="hidden" name="key" value={settingKey} />
      <div className="flex flex-wrap items-baseline gap-x-2">
        <label
          htmlFor={`setting-${settingKey}`}
          className="font-mono text-[12px] font-medium"
        >
          {settingKey}
        </label>
        <span className="font-mono text-[10.5px] text-faint">
          {source ?? "unset"}
          {env && ` · env ${env}`}
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          id={`setting-${settingKey}`}
          name="value"
          defaultValue={source === "owner" ? (value ?? "") : ""}
          placeholder={value ?? hint ?? ""}
          className="h-9 font-mono text-[12.5px]"
        />
        <Submit>Save</Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}

function NumberField({
  label,
  name,
  defaultValue,
}: {
  label: string
  name: string
  defaultValue: string | number
}) {
  return (
    <label className="flex flex-col gap-1 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <Input
        name={name}
        defaultValue={defaultValue}
        inputMode="decimal"
        className="h-9 font-mono text-[12.5px]"
      />
    </label>
  )
}

export function PlanForm({ plan }: { plan: Plan }) {
  const [state, action] = useActionState<OwnerState, FormData>(savePlan, null)
  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-xl border bg-surface p-4"
    >
      <input type="hidden" name="id" value={plan.id} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{plan.id}</span>
        {plan.isDefault && (
          <span className="rounded bg-rigel-soft px-1.5 font-mono text-[10px] text-rigel">
            default
          </span>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-[12px]">
          <input
            type="checkbox"
            name="active"
            defaultChecked={plan.active}
            className="accent-[var(--rigel)]"
          />
          Available to customers
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-muted-foreground">Name</span>
          <Input name="name" defaultValue={plan.name} className="h-9" />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-muted-foreground">Description</span>
          <Input
            name="description"
            defaultValue={plan.description ?? ""}
            className="h-9"
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <NumberField
          label="Price ₹ / month"
          name="priceRupees"
          defaultValue={
            plan.priceMonthlyPaise == null ? "" : plan.priceMonthlyPaise / 100
          }
        />
        <NumberField
          label="Included usage ₹"
          name="includedRupees"
          defaultValue={plan.includedUsageMicroInr / 1_000_000}
        />
        <NumberField
          label="Markup (bps, 10000 = 1×)"
          name="markupBps"
          defaultValue={plan.markupBps}
        />
        <NumberField label="Warn at %" name="warnAtPct" defaultValue={plan.warnAtPct} />
        <NumberField label="Agents" name="maxAgents" defaultValue={plan.maxAgents} />
        <NumberField
          label="Tasks / day"
          name="maxTasksPerDay"
          defaultValue={plan.maxTasksPerDay}
        />
        <NumberField
          label="Concurrent tasks"
          name="maxConcurrentTasks"
          defaultValue={plan.maxConcurrentTasks}
        />
        <NumberField
          label="Max task seconds"
          name="maxTaskSeconds"
          defaultValue={plan.maxTaskSeconds}
        />
        <NumberField label="Max steps" name="maxSteps" defaultValue={plan.maxSteps} />
        <NumberField
          label="Max cost / task (US cents)"
          name="maxTaskCostCents"
          defaultValue={plan.maxTaskCostMicroUsd / 10_000}
        />
        <NumberField
          label="Overage cap ₹"
          name="overageCapRupees"
          defaultValue={plan.overageCapMicroInr / 1_000_000}
        />
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-muted-foreground">Razorpay plan id</span>
          <Input
            name="razorpayPlanId"
            defaultValue={plan.razorpayPlanId ?? ""}
            className="h-9 font-mono text-[12px]"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[12px]">
        <span className="text-muted-foreground">Model levels:</span>
        {TIERS.map((tier) => (
          <label key={tier} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              name="allowedTiers"
              value={tier}
              defaultChecked={plan.allowedTiers.includes(tier)}
              className="accent-[var(--rigel)]"
            />
            {TIER_LABELS[tier].name}
          </label>
        ))}
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            name="overageAllowed"
            defaultChecked={plan.overageAllowed}
            className="accent-[var(--rigel)]"
          />
          Allow overage up to the cap
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Submit variant="default">Save plan</Submit>
        <StateNotice state={state} />
      </div>
    </form>
  )
}

export function ModelToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const [state, action] = useActionState<OwnerState, FormData>(setModelEnabled, null)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <Submit variant={enabled ? "outline" : "secondary"}>
        {enabled ? "Disable" : "Enable"}
      </Submit>
      {state?.error && (
        <span className="text-[11px] text-destructive">{state.error}</span>
      )}
    </form>
  )
}

export function AddModelForm() {
  const [state, action] = useActionState<OwnerState, FormData>(addModel, null)
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          name="id"
          placeholder="deepseek/deepseek-v4.1-flash-1017"
          className="h-9 font-mono text-[12.5px]"
        />
        <Submit>Add model</Submit>
      </div>
      <StateNotice state={state} />
    </form>
  )
}

function SingleAction({
  action: serverAction,
  label,
  hidden,
}: {
  action: (state: OwnerState, form: FormData) => Promise<OwnerState>
  label: string
  hidden?: Record<string, string>
}) {
  const [state, action] = useActionState<OwnerState, FormData>(serverAction, null)
  return (
    <form action={action} className="flex flex-col items-start gap-1.5">
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Submit>{label}</Submit>
      {(state?.error || state?.message) && (
        <span
          className={state.error ? "text-[11px] text-destructive" : "text-[11px] text-ok"}
        >
          {state.error ?? state.message}
        </span>
      )}
    </form>
  )
}

export function SyncCatalogueButton() {
  return <SingleAction action={() => refreshCatalogue()} label="Refresh prices" />
}

export function ReconcileButton() {
  return <SingleAction action={() => reconcileUsage()} label="Reconcile now" />
}

export function RetryTaskButton({ taskId }: { taskId: string }) {
  return <SingleAction action={retryTask} label="Retry" hidden={{ taskId }} />
}
