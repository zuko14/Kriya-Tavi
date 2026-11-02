"use client"

import * as React from "react"

import { reportRoom } from "@/actions/rooms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"

// Report a room or one of its messages to Kriya (R9, RD-18). The server
// copies the message as it is now, so Kriya sees it even if it's deleted;
// the people reported aren't told who reported them.

const REASONS = [
  ["spam", "Spam or scam"],
  ["harassment", "Harassment or abuse"],
  ["unsafe", "Dangerous or illegal"],
  ["private_info", "Someone's private information"],
  ["other", "Something else"],
] as const

export function ReportDialog({
  open,
  onOpenChange,
  roomId,
  messageId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomId: string
  // Absent: the whole room
  messageId?: string
}) {
  const [reason, setReason] = React.useState<(typeof REASONS)[number][0] | null>(null)
  const [note, setNote] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [sent, setSent] = React.useState(false)

  function change(next: boolean) {
    if (!next) {
      setReason(null)
      setNote("")
      setError(null)
      setSent(false)
    }
    onOpenChange(next)
  }

  async function send() {
    if (!reason) return
    setBusy(true)
    setError(null)
    const result = await reportRoom({
      roomId,
      messageId,
      reason,
      note: note.trim() || undefined,
    })
    setBusy(false)
    if ("error" in result) setError(result.error)
    else setSent(true)
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{messageId ? "Report message" : "Report room"}</DialogTitle>
          <DialogDescription>
            Kriya reviews reports. Nobody in the room is told who reported.
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="flex flex-col gap-3">
            <p role="status" className="text-[13.5px]">
              Thanks. Kriya will look at it. You can also block people from Room info.
            </p>
            <Button className="h-11" onClick={() => change(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <fieldset className="flex flex-col gap-1">
              <legend className="label-mono mb-1">Why</legend>
              {REASONS.map(([value, label]) => (
                <label
                  key={value}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 text-[13.5px] hover:bg-accent"
                >
                  <input
                    type="radio"
                    name="reason"
                    value={value}
                    checked={reason === value}
                    onChange={() => setReason(value)}
                    className="size-4 accent-rigel"
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Anything Kriya should know (optional)"
              aria-label="Details"
            />
            {error && (
              <p role="alert" className="text-[12.5px] text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="h-11" disabled={!reason || busy}>
              Send report
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
