"use client"

import * as React from "react"

import { reviewRoomReport } from "@/actions/rooms"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"

// The owner console's answer to one open room report (R9): reviewed,
// dismissed, or archive the room. The server checks the owner again.
export function ReportReview({
  reportId,
  active,
}: {
  reportId: string
  active: boolean
}) {
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function answer(outcome: "reviewed" | "dismissed" | "archive") {
    setBusy(true)
    setError(null)
    const result = await reviewRoomReport({ reportId, outcome })
    setBusy(false)
    if ("error" in result) setError(result.error)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button className="h-11" disabled={busy} onClick={() => answer("reviewed")}>
          Reviewed
        </Button>
        <Button
          variant="outline"
          className="h-11"
          disabled={busy}
          onClick={() => answer("dismissed")}
        >
          Dismiss
        </Button>
        {active && (
          <Confirm
            trigger={
              <Button variant="outline" className="h-11 text-destructive" disabled={busy}>
                Archive room
              </Button>
            }
            title="Archive this room?"
            description="Its members can still read it; nobody can post in it, and its own owner can't undo this. A line in the room says Kriya archived it."
            action="Archive"
            onConfirm={() => answer("archive")}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
