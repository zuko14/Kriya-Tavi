"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BotIcon, PlusIcon } from "lucide-react"

import { addRoomAgent, removeRoomAgent, setRoomAgentPolicy } from "@/actions/rooms"
import { Confirm } from "@/components/confirm"
import { Glyph } from "@/components/glyph"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatInr } from "@/lib/money"
import type { MyAgent, RoomAgent } from "@/queries/rooms"

// The agents sheet (UX_SPEC §2, R4): every agent in the room with its owner
// and who may ask it. An owner adds and removes their own agents and sets
// each one's policy here; only the owner sees its spend, others see only
// that a limit was reached (RD-17). Every rule is the server's.

export function RoomAgents({
  open,
  onOpenChange,
  roomId,
  active,
  agents,
  mine,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomId: string
  active: boolean
  agents: RoomAgent[]
  mine: MyAgent[]
}) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [choice, setAdding] = React.useState(mine[0]?.id ?? "")
  // After an add the list changes under the choice: fall back to the first
  const adding = mine.some((a) => a.id === choice) ? choice : (mine[0]?.id ?? "")
  const [busy, setBusy] = React.useState(false)

  async function run(action: () => Promise<{ error: string } | { ok: true }>) {
    setBusy(true)
    setError(null)
    const result = await action()
    setBusy(false)
    if ("error" in result) setError(result.error)
    else router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agents</DialogTitle>
          <DialogDescription>
            Each agent works in its owner&apos;s account. Only its owner approves what it
            does and pays for it.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}

        {agents.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No agents in this room yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-xl border">
            {agents.map((agent) => (
              <li key={agent.agentId} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Glyph seed={agent.glyph} className="size-6 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-[13.5px] font-medium">
                      {agent.name}{" "}
                      <span className="font-mono text-[10.5px] text-muted-foreground">
                        AI
                      </span>
                    </span>
                    <span className="truncate text-[11.5px] text-muted-foreground">
                      {agent.mine ? "Your agent" : `${agent.ownerName}'s agent`} ·{" "}
                      {agent.invoke === "members"
                        ? "anyone here can ask"
                        : `answers only to ${agent.mine ? "you" : agent.ownerName}`}
                      {agent.limitReached && " · today's limit reached"}
                    </span>
                  </span>
                </div>
                {agent.mine && agent.policy && (
                  <AgentPolicy
                    roomId={roomId}
                    agent={agent}
                    busy={busy || !active}
                    run={run}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {active && mine.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="label-mono">Add one of your agents</h3>
            <div className="flex items-center gap-2">
              <select
                aria-label="Agent to add"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-2 text-[13px]"
              >
                {mine.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <Button
                className="h-11"
                disabled={busy || !adding}
                onClick={() => run(() => addRoomAgent({ roomId, agentId: adding }))}
              >
                <PlusIcon />
                Add to room
              </Button>
            </div>
            <p className="text-[12px] text-muted-foreground">
              It reads this room&apos;s messages when someone asks it. By default only you
              can ask it.
            </p>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AgentPolicy({
  roomId,
  agent,
  busy,
  run,
}: {
  roomId: string
  agent: RoomAgent
  busy: boolean
  run: (action: () => Promise<{ error: string } | { ok: true }>) => Promise<void>
}) {
  const policy = agent.policy!
  const [invoke, setInvoke] = React.useState(agent.invoke)
  const [cap, setCap] = React.useState(
    policy.dailyCapMicroInr ? String(Math.floor(policy.dailyCapMicroInr / 1_000_000)) : ""
  )
  const [connectors, setConnectors] = React.useState(policy.allowConnectors)
  const id = `agent-${agent.agentId}`

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2.5">
      <label className="flex items-center gap-2 text-[13px]">
        Who can ask it
        <select
          value={invoke}
          onChange={(e) => setInvoke(e.target.value as typeof invoke)}
          className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-2 text-[13px]"
        >
          <option value="owner_only">Only me</option>
          <option value="members">Anyone in the room</option>
        </select>
      </label>
      {invoke === "members" && (
        <label className="flex items-center gap-2 text-[13px]">
          Daily limit for others, ₹
          <input
            inputMode="numeric"
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="h-11 w-24 rounded-lg border bg-background px-2 text-[13px] tabular-nums"
            aria-label="Daily limit in rupees"
          />
        </label>
      )}
      <p className="text-[12px] text-muted-foreground">
        Others&apos; requests today cost you {formatInr(policy.spentTodayMicroInr)}.
      </p>
      <label htmlFor={id} className="flex min-h-11 items-start gap-2.5 text-[13px]">
        <Checkbox
          id={id}
          checked={connectors}
          onCheckedChange={(checked) => setConnectors(checked === true)}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          Allow my connected accounts in this room
          <span className="text-[12px] text-muted-foreground">
            It could then read your mail, calendar or documents for someone here. Any
            reply that used them waits in your Inbox until you share it.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-11"
          disabled={busy}
          onClick={() =>
            run(() =>
              setRoomAgentPolicy({
                roomId,
                agentId: agent.agentId,
                invoke,
                ...(invoke === "members" && cap && { dailyCapRupees: Number(cap) }),
                allowConnectors: connectors,
              })
            )
          }
        >
          Save
        </Button>
        <Confirm
          trigger={
            <Button variant="ghost" className="h-11 text-destructive" disabled={busy}>
              <BotIcon />
              Remove from room
            </Button>
          }
          title={`Remove ${agent.name} from this room?`}
          description="It stops reading this room. Its replies stay."
          action="Remove"
          onConfirm={() => run(() => removeRoomAgent({ roomId, agentId: agent.agentId }))}
        />
      </div>
    </div>
  )
}
