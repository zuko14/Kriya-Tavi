import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { RoomView } from "@/components/rooms/room-view"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { roomAgentsOn } from "@/lib/rooms/agents"
import {
  getRoom,
  goalsFor,
  listInvites,
  myAgentsToAdd,
  notesFor,
  readMessages,
  roomAgentsFor,
} from "@/queries/rooms"

export const metadata: Metadata = { title: "Room" }

// A room (UX_SPEC §2): the last 100 messages, then Realtime pings or polling. Not found for
// anyone who isn't an active member, and for everyone with rooms.enabled off
// (getRoom returns null).
export default async function Page({ params }: { params: Promise<{ roomId: string }> }) {
  const user = await requireUser()
  const { roomId } = await params
  const page = await getRoom(user.id, roomId)
  if (!page) notFound()
  const admin = page.role === "owner" || page.role === "admin"
  // R4: the room's agents and the person's own to add; empty with rooms.agents off
  const [messages, invites, agents, mine, goals, notes] = await Promise.all([
    readMessages(user.id, roomId, { after: Math.max(page.room.lastSeq - 100, 0) }),
    admin ? listInvites(user.id, roomId) : [],
    roomAgentsFor(user.id, roomId),
    myAgentsToAdd(user.id, roomId),
    // R7: the room's goals
    goalsFor(user.id, roomId),
    // R8: the room's notes
    notesFor(user.id, roomId),
  ])
  const agentsOn = await roomAgentsOn()
  // Public values only: the project URL and the publishable key
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  const realtime =
    (await getSetting("rooms.realtime")) === "on" && url && key ? { url, key } : null

  return (
    <RoomView
      room={{
        ...page.room,
        role: page.role,
        members: page.members,
        blocked: page.blocked,
      }}
      me={user.id}
      initial={messages}
      invites={invites}
      realtime={realtime}
      agents={agentsOn ? { list: agents, mine } : null}
      goals={goals}
      notes={notes}
    />
  )
}
