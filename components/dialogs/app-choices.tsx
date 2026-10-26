"use client"

import * as React from "react"

import { setAppForAgent } from "@/actions/apps"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldDescription, FieldLabel } from "@/components/ui/field"
import { toast } from "@/components/ui/toast"
import type { AppChoice } from "@/queries/apps"

// The agent dialog's Apps section (N6, UX_SPEC §5): one checkbox per app the
// person has connected, "This agent may use it". Each tick is saved at once
// (the agent already exists; the choice is the person's, never an agent's).
export function AppChoices({ apps, agentId }: { apps: AppChoice[]; agentId: string }) {
  const [on, setOn] = React.useState(
    () =>
      new Set(apps.filter((a) => a.all || a.agents.includes(agentId)).map((a) => a.id))
  )
  const [busy, setBusy] = React.useState<string | null>(null)

  const toggle = async (app: AppChoice, next: boolean) => {
    setBusy(app.id)
    const result = await setAppForAgent(app.id, agentId, next).catch(() => ({
      error: "That didn't go through. Try again.",
    }))
    setBusy(null)
    if ("error" in result) {
      toast.add({
        type: "error",
        title: `Couldn't change ${app.name}`,
        description: result.error,
      })
      return
    }
    setOn((now) => {
      const copy = new Set(now)
      if (next) copy.add(app.id)
      else copy.delete(app.id)
      return copy
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <FieldLabel>Apps</FieldLabel>
      <FieldDescription>
        Apps you connected in Account. This agent can use only the ones you tick, and
        anything that changes something in an app still waits for your OK.
      </FieldDescription>
      {apps.map((app) => (
        <label
          key={app.id}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2"
        >
          <Checkbox
            checked={on.has(app.id)}
            disabled={busy === app.id}
            onCheckedChange={(next) => toggle(app, Boolean(next))}
            aria-label={`This agent may use ${app.name}`}
          />
          <span className="flex flex-col">
            <span className="text-[13px] font-medium">{app.name}</span>
            <span className="text-[12px] text-muted-foreground">
              This agent may use it
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}
