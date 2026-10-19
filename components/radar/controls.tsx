"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { markObligation, retractFact } from "@/actions/radar"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"

// The person's Radar buttons (K4) and the owner's Retract (K6)

const tap = "min-h-11 sm:min-h-8"

export function ObligationButtons({ id, missed }: { id: string; missed: boolean }) {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const act = (status: "done" | "dismissed") =>
    start(async () => {
      const result = await markObligation(id, status).catch(() => ({
        error: "That didn't go through. Try again.",
      }))
      setError("error" in result ? (result.error ?? null) : null)
      router.refresh()
    })
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" className={tap} disabled={pending} onClick={() => act("done")}>
        Done
      </Button>
      {!missed && (
        <Button
          size="xs"
          variant="ghost"
          className={tap}
          disabled={pending}
          onClick={() => act("dismissed")}
        >
          Dismiss
        </Button>
      )}
      {error && (
        <span role="alert" className="text-[12px] text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}

export function RetractFact({ factKey }: { factKey: string }) {
  const router = useRouter()
  return (
    <Confirm
      trigger={
        <Button size="xs" variant="destructive" className={tap}>
          Retract
        </Button>
      }
      title="Retract this fact?"
      description="It stops being served to everyone at once, and the retraction is written to the audit log. It stays retracted even if the page still says it."
      action="Retract"
      onConfirm={async () => {
        await retractFact(factKey)
        router.refresh()
      }}
    />
  )
}
