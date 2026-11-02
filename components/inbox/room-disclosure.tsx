"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ChevronRightIcon } from "lucide-react"

import { discardDisclosure, shareDisclosure } from "@/actions/rooms"
import { Glyph } from "@/components/glyph"
import { Button } from "@/components/ui/button"

// "Share in room?" (track R, R4; UX_SPEC §3, RD-06): an agent's reply that
// used the person's private data waits here. The exact text is what would
// be posted; nothing reaches the room until the person shares it.

const tap = "min-h-11 sm:min-h-8"

export function RoomDisclosure({
  item,
}: {
  item: {
    id: string
    roomId: string
    roomTitle: string
    agentName: string
    agentGlyph: string | null
    body: string | null
  }
}) {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const answer = (share: boolean) =>
    start(async () => {
      setError(null)
      const result = await (share ? shareDisclosure(item.id) : discardDisclosure(item.id))
      if ("error" in result) setError(result.error)
      else router.refresh()
    })

  return (
    <li className="glass flex flex-col gap-3 rounded-[20px] px-4 py-4">
      <div className="flex items-center gap-2">
        {item.agentGlyph && <Glyph seed={item.agentGlyph} className="size-6" />}
        <span className="text-[13px] font-semibold">{item.agentName}</span>
        <span className="ml-auto rounded-full bg-betelgeuse/15 px-2 py-0.5 font-mono text-[10.5px] text-betelgeuse">
          Used your private data
        </span>
      </div>
      <h3 className="text-[14.5px] leading-snug font-medium">
        Share {item.agentName}&apos;s reply in <strong>{item.roomTitle}</strong>?
      </h3>
      <blockquote className="max-h-60 overflow-y-auto rounded-xl border px-3 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
        {item.body}
      </blockquote>
      <p className="text-[12.5px] text-muted-foreground">
        Everyone in the room will see exactly this.
      </p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-2">
            <Button className={tap} disabled={pending} onClick={() => answer(true)}>
              Share in room
            </Button>
            <Button
              className={tap}
              variant="outline"
              disabled={pending}
              onClick={() => answer(false)}
            >
              Discard
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <Link
          href={`/rooms/${item.roomId}`}
          className="flex min-h-11 items-center gap-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground sm:min-h-0"
        >
          Open room <ChevronRightIcon className="size-3.5" />
        </Link>
      </div>
    </li>
  )
}
