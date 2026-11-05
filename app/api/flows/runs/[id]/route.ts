import { NextResponse } from "next/server"

import { authenticate } from "@/lib/auth"
import { flowsOn } from "@/lib/flows/on"
import { getRun } from "@/queries/flows"

// A run's state for its page's polling, as the person: someone else's run is
// a 404 (RLS). Gone with studio.flows off.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await authenticate()
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 })
  const { id } = await params
  if (!(await flowsOn()) || !/^[A-Za-z0-9_-]{1,32}$/.test(id))
    return NextResponse.json({ error: "Not found." }, { status: 404 })
  const view = await getRun(user.id, id)
  if (!view) return NextResponse.json({ error: "Not found." }, { status: 404 })
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } })
}
