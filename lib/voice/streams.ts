import { createHash } from "node:crypto"

import { sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"

// Media stream authorization (TELEPHONY_PROVIDER_ASSESSMENT.md §2.3): the
// provider's stream carries a one-time token minted for one attempt. Only
// its SHA-256 is stored (call_attempts.stream_token_hash).

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex")

export type ClaimedStream = { attemptId: string; userId: string }

// Uses the token, once: it must belong to an attempt that's dialing,
// ringing or answered, for this provider call id, and not used before. A
// single update, so two connections racing with one token can't both win.
// Privileged, scoped by the token's own attempt (AGENTS.md invariant 1);
// the status is left alone: answered → connected is the dialogue's step.
export async function claimStream(
  token: string,
  providerCallId: string,
  owner: string
): Promise<ClaimedStream | null> {
  if (!token || !providerCallId) return null
  const result = await privileged.execute(sql`
    update kriya.call_attempts set
      stream_token_used_at = now(),
      stream_owner = ${owner},
      stream_heartbeat_at = now()
    where stream_token_hash = ${hashToken(token)}
      and stream_token_used_at is null
      and status in ('initiated', 'ringing', 'answered')
      and provider_call_id = ${providerCallId}
    returning id, user_id`)
  const row = rowsOf<{ id: string; user_id: string }>(result)[0]
  return row ? { attemptId: row.id, userId: row.user_id } : null
}
