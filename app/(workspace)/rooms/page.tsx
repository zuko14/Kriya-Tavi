import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { BlockedList } from "@/components/rooms/blocked-list"
import { NewRoom } from "@/components/rooms/new-room"
import { RoomList } from "@/components/rooms/room-list"
import { requireUser } from "@/lib/auth"
import { roomsEnabled } from "@/lib/rooms/core"
import { blockedPeople, listRooms } from "@/queries/rooms"

export const metadata: Metadata = { title: "Rooms" }

// The person's rooms (track R, UX_SPEC §1). Gone with rooms.enabled off.
export default async function Page() {
  const user = await requireUser()
  if (!(await roomsEnabled())) notFound()
  const [rooms, blocked] = await Promise.all([listRooms(user.id), blockedPeople(user.id)])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
              Rooms
            </h1>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Work with people and their agents in one conversation.
            </p>
          </div>
          <NewRoom className="h-11" />
        </header>
        <RoomList rooms={rooms} />
        <BlockedList people={blocked} />
      </div>
    </div>
  )
}
