import { NextResponse } from "next/server"

import { authenticate } from "@/lib/auth"
import { roomsEnabled } from "@/lib/rooms/core"
import { readMessages } from "@/queries/rooms"

// A room's messages after a seq (REALTIME §1 catch-up): the room page polls
// it every 10 s, on focus and after its own posts. Through withUser, so a
// non-member, or someone removed, gets an empty list. Gone (404) with
// rooms.enabled off.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const user = await authenticate()
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 })
  const { roomId } = await params
  if (!UUID.test(roomId) || !(await roomsEnabled()))
    return NextResponse.json({ error: "Not found." }, { status: 404 })
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0)
  if (!Number.isSafeInteger(after) || after < 0)
    return NextResponse.json({ error: "That request wasn't valid." }, { status: 400 })
  const messages = await readMessages(user.id, roomId, { after })
  return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-store" } })
}
