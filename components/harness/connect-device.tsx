"use client"

import * as React from "react"

import { approveDevice, denyDevice } from "@/actions/harness"
import { Notice } from "@/components/auth/auth-kit"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// The person approves or denies a Kriya Harness sign-in (UX_SPEC §1). Only a
// signed-in session can answer; the terminal waits for this.

export function ConnectDevice({
  code,
  agents,
}: {
  code: string
  agents: { id: string; name: string; role: string }[]
}) {
  const [agentId, setAgentId] = React.useState(agents[0]?.id ?? "")
  const [busy, setBusy] = React.useState<"approve" | "deny" | null>(null)
  const [done, setDone] = React.useState<"approved" | "denied" | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const answer = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny")
    setError(null)
    const result = approve
      ? await approveDevice({ code, agentId: agentId || null })
      : await denyDevice({ code })
    setBusy(null)
    if ("error" in result) setError(result.error ?? null)
    else setDone(approve ? "approved" : "denied")
  }

  if (done === "approved")
    return (
      <Notice tone="success">
        Signed in. You can close this tab and return to your terminal.
      </Notice>
    )
  if (done === "denied")
    return <Notice tone="error">Denied. The device wasn&apos;t signed in.</Notice>

  return (
    <div className="flex flex-col gap-4">
      {agents.length > 0 && (
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Work as</span>
          <select
            className="min-h-11 rounded-md border bg-transparent px-3 text-[14px]"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} ({agent.role})
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button
          className="min-h-11 flex-1"
          disabled={busy !== null}
          onClick={() => answer(true)}
        >
          {busy === "approve" && <Spinner data-icon="inline-start" />}
          Approve
        </Button>
        <Button
          variant="outline"
          className="min-h-11 flex-1"
          disabled={busy !== null}
          onClick={() => answer(false)}
        >
          {busy === "deny" && <Spinner data-icon="inline-start" />}
          Deny
        </Button>
      </div>
    </div>
  )
}
