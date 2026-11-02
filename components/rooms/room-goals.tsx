"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BadgeCheckIcon, CheckIcon, CircleIcon, PlusIcon, Trash2Icon } from "lucide-react"

import {
  addGoalItem,
  closeGoalItemWithProof,
  confirmGoalItem,
  createGoal,
  dropRoomGoal,
  removeGoalItem,
  reopenGoalItem,
} from "@/actions/rooms"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { RoomGoal } from "@/queries/rooms"

// Room goals (UX_SPEC §2, R7, RD-13): a goal is a list of items; an item
// closes only with a verified action from a proof card in this room, or by
// a member's own confirmation, shown as "no proof". Done, open again or
// dropped is decided by the server from the items; this only offers what it
// allows.

// A verified action on a card in this room, as the attach picker lists it
export type ProofChoice = { messageId: string; index: number; label: string }

const STATE = {
  open: "Open",
  done: "Done",
  dropped: "Dropped",
} as const

export function RoomGoals({
  open,
  onOpenChange,
  roomId,
  active,
  admin,
  goals,
  proofs,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomId: string
  active: boolean
  // The person is the room's owner or an admin (may drop any goal)
  admin: boolean
  goals: RoomGoal[]
  proofs: ProofChoice[]
}) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [title, setTitle] = React.useState("")
  const [items, setItems] = React.useState("")

  async function run(action: () => Promise<{ error: string } | { ok: true }>) {
    setBusy(true)
    setError(null)
    const result = await action()
    setBusy(false)
    if ("error" in result) setError(result.error)
    else router.refresh()
    return result
  }

  async function create() {
    const list = items
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    const result = await run(() => createGoal({ roomId, title, items: list }))
    if ("ok" in result) {
      setTitle("")
      setItems("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Goals</DialogTitle>
          <DialogDescription>
            An item closes with a verified action from an agent&apos;s proof card, or when
            someone confirms it without proof. A goal is done when every item is closed.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}

        {goals.length === 0 && (
          <p className="text-[13px] text-muted-foreground">No goals in this room yet.</p>
        )}

        {goals.map((goal) => {
          const closed = goal.items.filter((i) => i.closed).length
          const live = active && goal.status !== "dropped"
          return (
            <section key={goal.id} className="flex flex-col gap-2 rounded-xl border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col leading-tight">
                  <h3 className="text-[14px] font-semibold break-words">{goal.title}</h3>
                  <span
                    className={cn(
                      "text-[11.5px]",
                      goal.status === "done" ? "text-rigel" : "text-muted-foreground"
                    )}
                  >
                    {STATE[goal.status]} · {closed} of {goal.items.length} closed
                  </span>
                </div>
                {live && (goal.mine || admin) && (
                  <Confirm
                    trigger={
                      <Button variant="ghost" className="h-11 shrink-0 text-destructive">
                        Drop
                      </Button>
                    }
                    title={`Drop “${goal.title}”?`}
                    description="It stays in the room's history as dropped."
                    action="Drop goal"
                    onConfirm={async () => {
                      await run(() => dropRoomGoal({ roomId, goalId: goal.id }))
                    }}
                  />
                )}
              </div>
              <ul className="flex flex-col divide-y">
                {goal.items.map((item) => (
                  <GoalItem
                    key={item.id}
                    roomId={roomId}
                    item={item}
                    live={live}
                    busy={busy}
                    proofs={proofs}
                    run={run}
                  />
                ))}
              </ul>
              {live && <AddItem roomId={roomId} goalId={goal.id} busy={busy} run={run} />}
            </section>
          )
        })}

        {active && (
          <section className="flex flex-col gap-2 border-t pt-4">
            <h3 className="label-mono">New goal</h3>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="Launch ready"
              aria-label="Goal"
              className="h-11 rounded-lg border bg-background px-3 text-[14px]"
            />
            <Textarea
              value={items}
              onChange={(e) => setItems(e.target.value)}
              rows={3}
              placeholder={"One item per line, e.g.\nPR merged\nPrice sheet updated"}
              aria-label="Items, one per line"
              className="min-h-11 text-[14px]"
            />
            <Button
              className="h-11 w-fit"
              disabled={busy || !title.trim() || !items.trim()}
              onClick={create}
            >
              <PlusIcon />
              Set goal
            </Button>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}

function GoalItem({
  roomId,
  item,
  live,
  busy,
  proofs,
  run,
}: {
  roomId: string
  item: RoomGoal["items"][number]
  live: boolean
  busy: boolean
  proofs: ProofChoice[]
  run: (action: () => Promise<{ error: string } | { ok: true }>) => Promise<unknown>
}) {
  const [choice, setChoice] = React.useState("")
  const ids = { roomId, itemId: item.id }
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-start gap-2">
        {item.closed ? (
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-rigel" />
        ) : (
          <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 text-[13.5px] break-words">{item.text}</span>
        {live && (
          <button
            type="button"
            aria-label={`Remove “${item.text}”`}
            disabled={busy}
            onClick={() => run(() => removeGoalItem(ids))}
            className="grid size-11 shrink-0 place-items-center rounded-full text-faint hover:text-destructive"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        )}
      </div>
      {item.closed ? (
        <div className="flex flex-wrap items-center gap-2 pl-6 text-[12px] text-muted-foreground">
          {item.closed.proof ? (
            <span className="flex items-center gap-1 text-rigel">
              <BadgeCheckIcon className="size-3.5" /> {item.closed.proof.title} ·{" "}
              {item.closed.proof.agent}
            </span>
          ) : (
            <span>Confirmed by {item.closed.confirmedBy}, no proof</span>
          )}
          {live && (
            <Button
              variant="ghost"
              className="h-11"
              disabled={busy}
              onClick={() => run(() => reopenGoalItem(ids))}
            >
              Reopen
            </Button>
          )}
        </div>
      ) : (
        live && (
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              aria-label={`Proof for “${item.text}”`}
              className="h-11 max-w-full min-w-0 flex-1 rounded-lg border bg-background px-2 text-[12.5px]"
            >
              <option value="">
                {proofs.length ? "Attach a verified action…" : "No verified actions yet"}
              </option>
              {proofs.map((p) => (
                <option
                  key={`${p.messageId}:${p.index}`}
                  value={`${p.messageId}:${p.index}`}
                >
                  {p.label}
                </option>
              ))}
            </select>
            <Button
              className="h-11"
              disabled={busy || !choice}
              onClick={() => {
                const [messageId, index] = choice.split(":")
                void run(() =>
                  closeGoalItemWithProof({ ...ids, messageId, index: Number(index) })
                )
              }}
            >
              Close with proof
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => run(() => confirmGoalItem(ids))}
            >
              Confirm, no proof
            </Button>
          </div>
        )
      )}
    </li>
  )
}

function AddItem({
  roomId,
  goalId,
  busy,
  run,
}: {
  roomId: string
  goalId: string
  busy: boolean
  run: (action: () => Promise<{ error: string } | { ok: true }>) => Promise<unknown>
}) {
  const [text, setText] = React.useState("")
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!text.trim()) return
        void run(() => addGoalItem({ roomId, goalId, text })).then(() => setText(""))
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={300}
        placeholder="Add an item"
        aria-label="New item"
        className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-3 text-[13.5px]"
      />
      <Button
        type="submit"
        variant="outline"
        className="h-11"
        disabled={busy || !text.trim()}
      >
        Add
      </Button>
    </form>
  )
}
