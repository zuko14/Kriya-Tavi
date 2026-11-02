import { NextResponse } from "next/server"

import { authenticate } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { allow } from "@/lib/rate-limit"
import { roomsEnabled } from "@/lib/rooms/core"
import { createSupabase } from "@/lib/supabase"

// The room page's way into Supabase Realtime (RF-06 option (a), built on the
// owner's "Do what are not done", 2026-10-31): the session cookies are httpOnly, so the
// page asks here for its own access token to join the private channel
// room:<id>, whose policy admits active members only. The token is the
// person's own and nobody else's; it stays in page memory, never in storage.
// Gone (404) unless rooms.enabled and rooms.realtime are on.

export async function GET() {
  const user = await authenticate()
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 })
  if (!(await roomsEnabled()) || (await getSetting("rooms.realtime")) !== "on")
    return NextResponse.json({ error: "Not found." }, { status: 404 })
  if (!(await allow(`rooms:realtime:${user.id}`, 30, 60)))
    return NextResponse.json({ error: "Too many requests." }, { status: 429 })
  const { data } = await (await createSupabase()).auth.getSession()
  if (!data.session)
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 })
  return NextResponse.json(
    { token: data.session.access_token, expiresAt: data.session.expires_at },
    { headers: { "Cache-Control": "no-store" } }
  )
}
