import { z } from "zod"

import { authenticate } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { previewLink } from "@/lib/editing/previews"

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" }

// The person's own checked preview: a redirect to a 1-hour link, so a player can
// seek (EH-25). The row is looked up as the person (RLS), so another person's id
// finds nothing.
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await authenticate()
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 })
  const id = z.uuid().safeParse((await ctx.params).id)
  const url =
    id.success && (await getSetting("editing.previews")) === "on"
      ? await previewLink(user.id, id.data)
      : null
  if (!url)
    return Response.json(
      { error: "Preview not found." },
      { status: 404, headers: NO_STORE }
    )
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: url } })
}
