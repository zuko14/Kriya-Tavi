import Link from "next/link"
import { ChevronRightIcon, MessagesSquareIcon } from "lucide-react"

import type { RoomRow } from "@/queries/rooms"

// The person's rooms with unread counts (UX_SPEC §1, §4), on /rooms and,
// cut to three, on Home. Server-rendered: no state.

const unreadOf = (room: RoomRow) => Math.max(room.lastSeq - room.lastReadSeq, 0)

export function RoomList({ rooms }: { rooms: RoomRow[] }) {
  if (rooms.length === 0)
    return (
      <p className="glass rounded-[20px] px-4 py-6 text-center text-[13.5px] leading-relaxed text-muted-foreground">
        Rooms are for working with people and their agents. Start one and invite someone.
      </p>
    )
  return (
    <ul className="glass divide-y overflow-hidden rounded-[20px]">
      {rooms.map((room) => {
        const unread = unreadOf(room)
        return (
          <li key={room.id}>
            <Link
              href={`/rooms/${room.id}`}
              className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
            >
              <MessagesSquareIcon className="size-4 shrink-0 text-rigel" />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[13.5px] font-medium">{room.title}</span>
                {room.status === "archived" && (
                  <span className="label-mono text-muted-foreground">Archived</span>
                )}
              </span>
              {unread > 0 && (
                <span className="shrink-0 rounded-full bg-rigel/15 px-2 py-0.5 font-mono text-[11px] text-rigel tabular-nums">
                  {unread} new
                </span>
              )}
              <ChevronRightIcon className="size-4 shrink-0 text-faint" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
