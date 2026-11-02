"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { unblockPerson } from "@/actions/rooms"
import { Button } from "@/components/ui/button"
import type { BlockedPerson } from "@/queries/rooms"

// The people the person blocked (R9, RD-18), so they can unblock someone
// they no longer share a room with. Shown only when the list isn't empty.
export function BlockedList({ people }: { people: BlockedPerson[] }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  if (people.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="label-mono">Blocked · {people.length}</h2>
      <p className="text-[12.5px] text-muted-foreground">
        Their messages collapse for you, they can&apos;t ask your agents, and neither of
        you can join a room through the other&apos;s invite.
      </p>
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
      <ul className="flex flex-col divide-y rounded-xl border">
        {people.map((person) => (
          <li
            key={person.userId}
            className="flex min-h-12 items-center gap-2 px-3 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{person.name}</span>
            <Button
              variant="ghost"
              className="h-11"
              onClick={async () => {
                setError(null)
                const result = await unblockPerson({ userId: person.userId })
                if ("error" in result) setError(result.error)
                else router.refresh()
              }}
            >
              Unblock
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
