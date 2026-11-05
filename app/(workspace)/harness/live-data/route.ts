import { z } from "zod"

import { getSessionUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { liveFeed, liveSessions } from "@/lib/harness/live"

// The Remote Control views' polling, as the signed-in person: the list, or
// with ?session= one session's events after ?after=
export async function GET(request: Request) {
  if (
    (await getSetting("harness.api")) !== "on" ||
    (await getSetting("harness.remoteControl")) !== "on"
  )
    return Response.json({ error: "Not found." }, { status: 404 })
  const user = await getSessionUser()
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 })
  const headers = { "cache-control": "no-store" }
  const params = new URL(request.url).searchParams
  if (!params.has("session"))
    return Response.json(await liveSessions(user.id), { headers })
  const id = z.uuid().safeParse(params.get("session"))
  const after = z.coerce
    .number()
    .int()
    .min(-1)
    .safeParse(params.get("after") ?? -1)
  const feed =
    id.success && after.success ? await liveFeed(user.id, id.data, after.data) : null
  return feed
    ? Response.json(feed, { headers })
    : Response.json({ error: "Not found." }, { status: 404 })
}
