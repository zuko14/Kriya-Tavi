import { asc } from "drizzle-orm"

import { withUser } from "@/db"
import { loginProfiles } from "@/db/schema"

// Account → Logins: metadata only, read as the person (the sealed state
// isn't selectable by their session at all, AT-SEC-01)
export function listLogins(userId: string) {
  return withUser(userId, (tx) =>
    tx
      .select({
        id: loginProfiles.id,
        domain: loginProfiles.domain,
        label: loginProfiles.label,
        status: loginProfiles.status,
        backgroundAllowed: loginProfiles.backgroundAllowed,
        lastUsedAt: loginProfiles.lastUsedAt,
        expiresAt: loginProfiles.expiresAt,
      })
      .from(loginProfiles)
      .orderBy(asc(loginProfiles.domain), asc(loginProfiles.createdAt))
  )
}
