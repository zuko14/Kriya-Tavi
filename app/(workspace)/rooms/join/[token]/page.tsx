import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { JoinRoom } from "@/components/rooms/join-room"
import { requireUser } from "@/lib/auth"
import { roomsEnabled } from "@/lib/rooms/core"

export const metadata: Metadata = { title: "Join a room" }

// An invite link (RD-11). Signed-out visitors were sent to sign in by
// proxy.ts and come back here; the token is checked only when they press
// Join (joinRoom), never shown or stored.
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  await requireUser()
  if (!(await roomsEnabled())) notFound()
  const { token } = await params

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-lg flex-col gap-5 px-4 py-10 sm:py-16">
        <h1 className="font-display text-[28px] leading-none font-normal">Join a room</h1>
        <JoinRoom token={token} />
      </div>
    </div>
  )
}
