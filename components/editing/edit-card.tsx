"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { answerEditQuestion, dismissFound, startFromFound } from "@/actions/editing"
import { Button } from "@/components/ui/button"
import type { EditCard } from "@/queries/editing-types"

// A card from the person's computer (TAVI_INTEGRATION §5, §8). Answering is theirs alone.
// A new recording's name came from that computer, and is only ever shown as text.

type Choice = { label: string; clip?: string }
type Found = { name: string; seconds: number }

const span = (seconds: number) => {
  if (seconds < 90) return `${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes} minutes` : `${(minutes / 60).toFixed(1)} hours`
}

export function EditCardView({ card }: { card: EditCard }) {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const act = (work: () => Promise<{ error?: string } | { ok: true }>) =>
    start(async () => {
      setError(null)
      const result = await work()
      if ("error" in result && result.error) setError(result.error)
      router.refresh()
    })
  const found = card.kind === "found" ? (card.options as Found) : null
  const choices = found ? [] : (card.options as Choice[])

  return (
    <li className="glass flex flex-col gap-3 rounded-[20px] px-4 py-4">
      <span className="label-mono text-faint">Editing · {card.deviceName}</span>
      {found ? (
        <>
          <h3 className="text-[14.5px] leading-snug font-medium">
            New recording, {span(found.seconds)}. Make a reel?
          </h3>
          <p className="text-[13px] break-words text-muted-foreground">{found.name}</p>
          <p className="text-[12px] text-faint">
            Nothing has run. It starts on your computer only if you say so.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={pending}
              onClick={() => act(() => startFromFound(card.id))}
            >
              Make a reel
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={() => act(() => dismissFound(card.id))}
            >
              Not this one
            </Button>
          </div>
        </>
      ) : (
        <>
          <h3 className="text-[14.5px] leading-snug font-medium">{card.prompt}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {choices.map((choice, option) => (
              <div key={option} className="flex flex-col gap-2">
                {choice.clip && (
                  <video
                    src={`/api/editing/preview/${choice.clip}`}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label={choice.label}
                    className="aspect-video w-full rounded-xl bg-black object-contain"
                  />
                )}
                <Button
                  variant="outline"
                  className="h-auto min-h-11 whitespace-normal"
                  disabled={pending}
                  onClick={() => act(() => answerEditQuestion(card.id, option))}
                >
                  {choice.label}
                  {option === card.defaultOption && (
                    <span className="ml-1.5 text-[11px] text-faint">(default)</span>
                  )}
                </Button>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-faint">
            If you don&apos;t answer, your computer goes on with the default.
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}
