import { z } from "zod"

import { authenticate } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { downloadUrl } from "@/lib/files"

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" }

// The person's own file: a redirect to a 60 s signed link (AD-19). The row
// is looked up as the person (RLS), so another person's id finds nothing.
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ fileId: string }> }
) {
  const user = await authenticate()
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 })
  const id = z.uuid().safeParse((await ctx.params).fileId)
  const url =
    id.success && (await getSetting("agents.files")) === "on"
      ? await downloadUrl(user.id, id.data)
      : null
  if (!url)
    return Response.json({ error: "File not found." }, { status: 404, headers: NO_STORE })
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: url } })
}
