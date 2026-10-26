import type { DeliveryCheckRow, Episode, EpisodeClaim } from "@/db/schema"

// Delivery status (ND-03): one answer to "did it get done?", computed by
// code from a task's "What I did" record and the later checks of its runs.
// Never stored (a late check simply changes the next read), never shown to
// or set by a model, and the episode and its receipt hash are never touched.
// Pure; imports no next/*.

export type DeliveryStatus =
  "delivered" | "partly" | "not_confirmed" | "nothing_to_deliver"
export type DeliveryCheck = Pick<DeliveryCheckRow, "executionId" | "status" | "kind">

export function deliveryOf(
  episode: Pick<Episode, "done" | "unconfirmed" | "checks">,
  checks: DeliveryCheck[]
): {
  status: DeliveryStatus
  // Unconfirmed entries no later check has verified
  open: EpisodeClaim[]
  // Runs a later check verified (they count as done)
  laterVerified: string[]
  // Runs a later check found were made but are no longer there (never verified)
  gone: string[]
} {
  const verified = new Set<string>()
  const goneIds = new Set<string>()
  for (const check of checks) {
    if (check.status === "verified") verified.add(check.executionId)
    else if (check.status === "gone") goneIds.add(check.executionId)
  }
  const resolved = (claim: EpisodeClaim) =>
    claim.executionId !== undefined && verified.has(claim.executionId)
  const open = episode.unconfirmed.filter((claim) => !resolved(claim))
  const laterVerified = episode.unconfirmed.flatMap((claim) =>
    resolved(claim) ? [claim.executionId!] : []
  )
  const gone = episode.unconfirmed.flatMap((claim) =>
    claim.executionId &&
    !verified.has(claim.executionId) &&
    goneIds.has(claim.executionId)
      ? [claim.executionId]
      : []
  )
  const unsupported = episode.checks.some((check) => check.status === "unsupported")
  const accomplished = episode.done.length + laterVerified.length

  const status: DeliveryStatus =
    accomplished > 0
      ? open.length === 0 && !unsupported
        ? "delivered"
        : "partly"
      : open.length > 0
        ? "not_confirmed"
        : "nothing_to_deliver"
  return { status, open, laterVerified, gone }
}

// What a "What I did" card needs: the status, and when each later-verified
// run was checked (ISO text, so it crosses the server-action boundary)
export function deliveryView(
  episode: Pick<Episode, "done" | "unconfirmed" | "checks">,
  checks: (DeliveryCheck & { checkedAt: Date })[]
) {
  const result = deliveryOf(episode, checks)
  const checkedAt: Record<string, string> = {}
  for (const check of checks) {
    if (check.status !== "verified") continue
    const at = check.checkedAt.toISOString()
    if (!checkedAt[check.executionId] || at > checkedAt[check.executionId])
      checkedAt[check.executionId] = at
  }
  return {
    status: result.status,
    laterVerified: result.laterVerified.map((executionId) => ({
      executionId,
      checkedAt: checkedAt[executionId],
    })),
    gone: result.gone,
  }
}
