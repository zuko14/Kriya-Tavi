import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { withUser } from "@/db"
import { browserSessions } from "@/db/schema"
import { authenticate } from "@/lib/auth"
import { mintLiveToken } from "@/lib/browser/live"
import { getSetting } from "@/lib/config"
import { allow } from "@/lib/rate-limit"

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" }

// A one-time live-view token (BROWSER_AND_LOGIN_PROFILES.md §5, AT-BRW-12):
// only for the person's own open browser session, which is looked up as
// them (RLS), valid for 60 s and for one socket. kriya-browser checks it
// before sending a single frame.
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ sessionId: string }> }
) {
  const user = await authenticate()
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 })
  if ((await getSetting("agents.loginProfiles")) !== "on") {
    return Response.json({ error: "Not available." }, { status: 404, headers: NO_STORE })
  }
  const id = z.uuid().safeParse((await ctx.params).sessionId)
  if (!id.success) {
    return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE })
  }
  const secret = process.env.KRIYA_BROWSER_SECRET?.trim()
  const base = process.env.KRIYA_BROWSER_LIVE_URL?.trim().replace(/\/+$/, "")
  if (!secret || !base) {
    return Response.json(
      { error: "The live view isn't set up on this server yet." },
      { status: 503, headers: NO_STORE }
    )
  }
  if (!(await allow(`live:${user.id}`, 60, 3600))) {
    return Response.json(
      { error: "Too many tries. Wait a minute." },
      { status: 429, headers: NO_STORE }
    )
  }
  const [session] = await withUser(user.id, (tx) =>
    tx
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.id, id.data),
          inArray(browserSessions.status, ["open", "paused"])
        )
      )
  )
  if (!session) {
    return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE })
  }
  const token = mintLiveToken(session.id, user.id, secret)
  return Response.json(
    { url: `${base}/live/${session.id}?token=${encodeURIComponent(token)}` },
    { headers: NO_STORE }
  )
}
