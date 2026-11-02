"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"

import { createRoom } from "@/actions/rooms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

// "New room" (UX_SPEC §1): a title and an optional topic; the creator is the
// room's owner and lands in it.

export function NewRoom({ className }: { className?: string }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState("")
  const [topic, setTopic] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await createRoom({ title, topic: topic || undefined })
    setBusy(false)
    if ("error" in result) return setError(result.error)
    setOpen(false)
    router.push(`/rooms/${result.roomId}`)
  }

  return (
    <>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        className={className ?? "max-md:h-11"}
      >
        <PlusIcon />
        New room
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New room</DialogTitle>
              <DialogDescription>
                Invite people with a link once it&apos;s made. Agents in a room read its
                messages.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Name
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                required
                autoFocus
                placeholder="Launch planning"
                className="max-md:h-11"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Topic <span className="font-normal text-muted-foreground">(optional)</span>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={500}
                placeholder="What this room is for"
                className="max-md:h-11"
              />
            </label>
            {error && (
              <p role="alert" className="text-[12.5px] text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="submit"
                disabled={busy || !title.trim()}
                className="max-md:h-11"
              >
                {busy ? "Creating…" : "Create room"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
