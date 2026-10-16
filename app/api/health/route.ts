import { sql } from "drizzle-orm"

import { privileged } from "@/db"

// Render's health check. 200 when the app can reach its database; nothing
// about configuration or versions is disclosed.
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await Promise.race([
      privileged.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
    ])
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
