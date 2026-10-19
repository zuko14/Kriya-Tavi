"use client"

import * as React from "react"
import { BookmarkIcon } from "lucide-react"

import { usedMemories, type UsedMemory } from "@/actions/memory"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

// "Used N memories" under a reply (UX_SPEC §10): opens the notes the agent
// was given for it. Only replies written with agents.memoryV2 on carry ids.
export function UsedMemories({ ids }: { ids: string[] }) {
  const [notes, setNotes] = React.useState<UsedMemory[] | null>(null)
  const [error, setError] = React.useState(false)

  const load = (open: boolean) => {
    if (!open || notes) return
    setError(false)
    usedMemories(ids).then(setNotes, () => setError(true))
  }

  return (
    <Popover onOpenChange={load}>
      <PopoverTrigger className="-my-3 flex min-h-11 items-center gap-1 hover:text-foreground sm:my-0 sm:min-h-0">
        <BookmarkIcon className="size-3" />
        Used {ids.length} {ids.length === 1 ? "memory" : "memories"}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-80 overflow-y-auto">
        {error ? (
          <p className="text-[13px] text-muted-foreground">
            Couldn&apos;t load these notes.
          </p>
        ) : !notes ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            These notes have since been forgotten.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} className="flex flex-col gap-0.5">
                <span className="text-[13px] leading-snug">{note.content}</span>
                <span className="label-mono text-faint">
                  {note.kind}
                  {note.agentName ? ` · ${note.agentName}` : " · about you"}
                  {note.trust === "unconfirmed" && " · unconfirmed"}
                  {!note.current && " · since changed"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
