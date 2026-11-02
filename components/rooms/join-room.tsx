"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { joinRoom } from "@/actions/rooms"
import { Button } from "@/components/ui/button"

// /rooms/join/<token> (RD-11): joining is a deliberate press, after the
// consent line (RS-12). The room's name isn't shown first: nobody outside a
// room can read it.

export function JoinRoom({ token }: { token: string }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function join() {
    setBusy(true)
    setError(null)
    const result = await joinRoom(token)
    if ("error" in result) {
      setBusy(false)
      return setError(result.error)
    }
    router.replace(`/rooms/${result.roomId}`)
  }

  return (
    <div className="glass flex flex-col gap-4 rounded-[22px] p-5">
      <p className="text-[14px] leading-relaxed">
        You&apos;ve been invited to a room on Kriya. People in it, and their agents, read
        its messages. Rooms aren&apos;t end-to-end encrypted.
      </p>
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      <Button onClick={join} disabled={busy} className="h-11 self-start px-5">
        {busy ? "Joining…" : "Join the room"}
      </Button>
    </div>
  )
}
