"use client"

import * as React from "react"
import { formatDistanceToNowStrict } from "date-fns"
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react"

import { addMemory, clearMemories, deleteMemory, listMemories } from "@/actions/memory"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import type { Memory } from "@/db/schema"

export function MemoryPanel({
  agentId,
  refreshKey,
}: {
  agentId: string
  refreshKey: number
}) {
  const [notes, setNotes] = React.useState<Memory[] | null>(null)
  const [draft, setDraft] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let live = true
    listMemories(agentId).then((rows) => live && setNotes(rows))
    return () => {
      live = false
    }
  }, [agentId, refreshKey])

  const add = async () => {
    const content = draft.trim()
    if (!content) return
    setSaving(true)
    try {
      setNotes(await addMemory(agentId, content))
      setDraft("")
    } catch (error) {
      toast.add({
        type: "error",
        title: "Couldn't save the note",
        description: String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Notes this agent keeps across every thread. They are loaded into its context on
          each turn and stored only in your local database.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
          className="flex gap-1.5"
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a note…"
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[12.5px] outline-none placeholder:text-faint focus-visible:border-ring dark:bg-input/30"
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="outline"
            disabled={!draft.trim() || saving}
            aria-label="Add note"
          >
            {saving ? <Spinner /> : <PlusIcon />}
          </Button>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {notes === null ? (
          <div className="grid place-items-center p-6">
            <Spinner className="text-muted-foreground" />
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center gap-1 p-8 text-center">
            <span className="font-mono text-[11px] text-faint">{"// empty"}</span>
            <p className="text-[12.5px] text-muted-foreground">
              Nothing remembered yet. Tell the agent something worth keeping.
            </p>
          </div>
        ) : (
          <ul className="divide-y">
            {notes.map((note) => (
              <li key={note.id} className="group/note flex gap-2 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-[13px] leading-snug">{note.content}</p>
                  <span className="font-mono text-[10px] text-faint">
                    {note.id} ·{" "}
                    {formatDistanceToNowStrict(new Date(note.createdAt), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label="Forget"
                  onClick={async () => setNotes(await deleteMemory(agentId, note.id))}
                  className="grid size-6 shrink-0 place-items-center rounded-sm text-faint opacity-0 transition-opacity group-hover/note:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {notes && notes.length > 0 && (
        <div className="flex items-center border-t px-3 py-2">
          <span className="font-mono text-[10.5px] text-faint">{notes.length} notes</span>
          <Confirm
            trigger={
              <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground">
                <Trash2Icon data-icon="inline-start" />
                Clear
              </Button>
            }
            title="Clear this agent's memory?"
            description="Every note is deleted. The agent starts its next turn remembering nothing about you."
            action="Clear memory"
            onConfirm={async () => setNotes(await clearMemories(agentId))}
          />
        </div>
      )}
    </div>
  )
}
