import "server-only"

import { createHash } from "node:crypto"

import { sql } from "drizzle-orm"
import { headers } from "next/headers"

import { privileged, rowsOf } from "@/db"

// Fixed-window limits kept in Postgres, so they hold across every web
// instance. Keys are hashed: an email address never sits in the table.

export async function clientIp() {
  const list = (await headers()).get("x-forwarded-for") ?? ""
  // Render's proxy appends the client address first
  return list.split(",")[0]?.trim() || "unknown"
}

function hashed(key: string) {
  return createHash("sha256").update(key).digest("base64url").slice(0, 32)
}

export async function allow(key: string, max: number, windowSeconds: number) {
  const result = await privileged.execute(
    sql`select kriya.hit_rate_limit(${hashed(key)}, ${max}, ${windowSeconds}) as ok`
  )
  return !!rowsOf<{ ok: boolean }>(result)[0]?.ok
}

// Several limits at once: per address and per account
export async function allowAll(
  limits: [key: string, max: number, windowSeconds: number][]
) {
  const results = await Promise.all(limits.map((limit) => allow(...limit)))
  return results.every(Boolean)
}
