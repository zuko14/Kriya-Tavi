import { getSetting } from "@/lib/config"
import { log } from "@/lib/log"

// The ping after a committed room message (RD-10, REALTIME §1): Supabase
// Realtime's REST broadcast to the private channel room:<id>, carrying only
// the new seq; members fetch the messages through withUser. Off unless
// rooms.realtime is on. A failed ping is logged and never fails the action:
// clients poll every 10 s anyway. The request has realtime-js httpSend's
// shape (the key as `apikey`, no Authorization without a session); that
// the secret key alone authorizes it is unverified until staging (RT-RLT-03).
// No server-only marker: the worker pings too (R4's relay), and plain Node
// refuses that marker; the secret key is read here only, never returned.

export async function pingRoom(roomId: string, seq: number) {
  if ((await getSetting("rooms.realtime")) !== "on") return
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) return
  try {
    const topic = encodeURIComponent(`room:${roomId}`)
    const response = await fetch(
      `${url}/realtime/v1/api/broadcast/${topic}/events/seq?private=true`,
      {
        method: "POST",
        headers: { apikey: key, "Content-Type": "application/json" },
        body: JSON.stringify({ seq }),
        signal: AbortSignal.timeout(3000),
      }
    )
    if (!response.ok) log.warn("rooms: realtime ping failed", { status: response.status })
  } catch (error) {
    log.warn("rooms: realtime ping failed", {
      error: error instanceof Error ? error.message : "unknown",
    })
  }
}
