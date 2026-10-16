"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MessageSquarePlusIcon } from "lucide-react"

import { createThread } from "@/actions/threads"
import { Glyph, SquadGlyph } from "@/components/glyph"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Shown when an agent or squad has no threads left
export function StartThread({
  owner,
  name,
  subtitle,
  glyphs,
}: {
  owner: { agentId: string } | { squadId: string }
  name: string
  subtitle: string
  glyphs: string[]
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const base = "agentId" in owner ? `/a/${owner.agentId}` : `/s/${owner.squadId}`

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      {"agentId" in owner ? (
        <Glyph seed={glyphs[0]} className="size-14" />
      ) : (
        <SquadGlyph seeds={glyphs} className="size-14" />
      )}
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">{name}</h1>
        <p className="font-mono text-[12px] text-muted-foreground">{subtitle}</p>
      </div>
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true)
          const id = await createThread(owner)
          router.push(`${base}/${id}`)
        }}
      >
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <MessageSquarePlusIcon data-icon="inline-start" />
        )}
        Start a thread
      </Button>
    </div>
  )
}
