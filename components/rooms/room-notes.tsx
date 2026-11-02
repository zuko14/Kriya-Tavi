"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BotIcon, CheckIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { addRoomNote, confirmRoomNote, deleteRoomNote } from "@/actions/rooms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { RoomNote } from "@/queries/rooms"

// Room notes (UX_SPEC §2, R8, RD-14): what the room keeps in view. People's
// notes count at once; an agent's note waits until a member confirms it,
// and only then do agents see it. Notes never go into anyone's memory.

export function RoomNotes({
  open,
  onOpenChange,
  roomId,
  active,
  notes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomId: string
  active: boolean
  notes: RoomNote[]
}) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [draft, setDraft] = React.useState("")

  async function run(action: () => Promise<{ error: string } | { ok: true }>) {
    setBusy(true)
    setError(null)
    const result = await action()
    setBusy(false)
    if ("error" in result) setError(result.error)
    else router.refresh()
    return result
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Notes</DialogTitle>
          <DialogDescription>
            Agents in this room read its notes. An agent&apos;s note counts only after a
            member confirms it. Notes don&apos;t go into anyone&apos;s memory.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}

        {notes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-xl border">
            {notes.map((note) => {
              const waiting = note.agent && !note.confirmedBy
              return (
                <li key={note.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                  <p className="text-[13.5px] break-words whitespace-pre-wrap">
                    {note.body}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                    {note.agent && <BotIcon className="size-3.5" />}
                    <span>{note.by}</span>
                    {note.agent && (
                      <span className={waiting ? "text-betelgeuse" : "text-rigel"}>
                        ·{" "}
                        {waiting
                          ? "not confirmed yet"
                          : `confirmed by ${note.confirmedBy}`}
                      </span>
                    )}
                    <span className="ml-auto flex gap-1">
                      {waiting && active && (
                        <Button
                          variant="outline"
                          className="h-11"
                          disabled={busy}
                          onClick={() =>
                            run(() => confirmRoomNote({ roomId, noteId: note.id }))
                          }
                        >
                          <CheckIcon />
                          Confirm
                        </Button>
                      )}
                      {note.mine && (
                        <button
                          type="button"
                          aria-label="Delete note"
                          disabled={busy}
                          onClick={() =>
                            run(() => deleteRoomNote({ roomId, noteId: note.id }))
                          }
                          className="grid size-11 place-items-center rounded-full text-faint hover:text-destructive"
                        >
                          <Trash2Icon className="size-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {active && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void run(() => addRoomNote({ roomId, body: draft })).then(
                (result) => "ok" in result && setDraft("")
              )
            }}
          >
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="A decision or fact everyone should keep in view"
              aria-label="New note"
              className="min-h-11 text-[14px]"
            />
            <Button type="submit" className="h-11 w-fit" disabled={busy || !draft.trim()}>
              <PlusIcon />
              Add note
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
