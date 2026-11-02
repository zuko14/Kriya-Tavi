import { and, eq, isNull } from "drizzle-orm"

import { privileged } from "@/db"
import {
  episodes,
  roomMessages,
  type EpisodeAction,
  type Verification,
} from "@/db/schema"
import { CAPABILITIES } from "@/lib/agent/capabilities"
import { postSystemLine } from "@/lib/rooms/agents"

// Proof cards (track R, R5; RD-09, CONVERSATION_PROTOCOL §4): what a room
// sees of what an agent verifiably did, copied by code from the bridge
// task's episode, never from model text. Only `url` and `provider_id`
// evidence is copied (`file` points at the owner's files); task and
// execution ids stay with the owner. No server-only marker: the worker's
// relay builds cards.

export type ProofEvidence = { kind: "url" | "provider_id"; value: string }

export type ProofCard = {
  kind: "proof"
  done: {
    title: string
    status: Verification["status"]
    method: Verification["method"]
    evidence: ProofEvidence[]
  }[]
  // Claims in the reply, and runs, that nothing verified
  unconfirmed: number
  checks: { supported: number; unsupported: number }
  // Other agents whose own verified runs matched this card's evidence
  verifiedBy: { agentId: string; agentName: string; ownerName: string; at: string }[]
}

type EpisodeFacts = {
  done: EpisodeAction[]
  unconfirmed: unknown[]
  checks: { status: string }[]
}

// A provider id is public only from an outside service (owner/repo#42);
// Kriya's own tools' ids are rows in the owner's account
const roomSafe = (evidence: Verification["evidence"], tool: string): ProofEvidence[] =>
  evidence.flatMap((e) =>
    e.kind === "url" ||
    (e.kind === "provider_id" && CAPABILITIES[tool]?.system !== "kriya")
      ? [{ kind: e.kind, value: e.value }]
      : []
  )

// The card, or null when there's nothing to show (no action, no claim, no check)
export function buildCard(episode: EpisodeFacts | null): ProofCard | null {
  if (!episode) return null
  const card: ProofCard = {
    kind: "proof",
    done: episode.done.map((item) => ({
      title: item.title,
      status: item.verification.status,
      method: item.verification.method,
      evidence: roomSafe(item.verification.evidence, item.tool),
    })),
    unconfirmed: episode.unconfirmed.length,
    checks: {
      supported: episode.checks.filter((c) => c.status === "supported").length,
      unsupported: episode.checks.filter((c) => c.status === "unsupported").length,
    },
    verifiedBy: [],
  }
  const empty =
    card.done.length === 0 &&
    card.unconfirmed === 0 &&
    card.checks.supported + card.checks.unsupported === 0
  return empty ? null : card
}

// The same page however it's written: scheme and host in lower case, no
// fragment, no trailing slash; the query stays (it can name the thing)
export function normalizeEvidence({ kind, value }: ProofEvidence) {
  if (kind === "provider_id") return `id:${value.trim()}`
  try {
    const url = new URL(value.trim())
    url.hash = ""
    const path = url.pathname.replace(/\/+$/, "")
    return `url:${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return `url:${value.trim()}`
  }
}

// RT-PRF-03: true only if one of the verifier's own verified runs carries
// the same evidence as the card. Unverified runs and text never count
export function confirms(card: ProofCard, verifier: EpisodeAction[]) {
  const claimed = new Set(
    card.done.flatMap((item) => item.evidence.map(normalizeEvidence))
  )
  return verifier.some(
    (item) =>
      item.verification.status === "verified" &&
      roomSafe(item.verification.evidence, item.tool).some((e) =>
        claimed.has(normalizeEvidence(e))
      )
  )
}

// What a verifying agent is asked to check: the card's claims, as text
export function cardRequest(agentName: string, card: ProofCard) {
  const lines = card.done.map(
    (item) =>
      `- ${item.title} (${item.status}, ${item.method})${
        item.evidence.length ? `: ${item.evidence.map((e) => e.value).join(", ")}` : ""
      }`
  )
  return `Check these claims from ${agentName}'s reply yourself, with your own tools, and say what you found:\n${lines.join("\n") || "- (no verified actions on the card)"}`
}

// After a reply to a card reaches the room (posted, or shared by its owner):
// if the replying agent's own verified runs match the card's evidence, the
// card gains "Independently verified by …" and the room a line saying so.
// Another agent only; once per agent
export async function markVerified({
  roomId,
  cardMessageId,
  verifier,
  agentId,
  agentName,
  ownerName,
}: {
  roomId: string
  cardMessageId: string
  verifier: EpisodeAction[]
  agentId: string
  agentName: string
  ownerName: string
}) {
  // The card row locked while its verifiedBy grows: two agents verifying at
  // once both stay on it (re-audit 2026-11-02)
  const marked = await privileged.transaction(async (tx) => {
    const [target] = await tx
      .select({ agentId: roomMessages.agentId, parts: roomMessages.parts })
      .from(roomMessages)
      .where(
        and(
          eq(roomMessages.id, cardMessageId),
          eq(roomMessages.roomId, roomId),
          eq(roomMessages.authorKind, "agent"),
          isNull(roomMessages.deletedAt)
        )
      )
      .for("update")
    const card = target?.parts.proof as ProofCard | undefined
    if (!target || !card || target.agentId === agentId) return false
    if (card.verifiedBy.some((v) => v.agentId === agentId)) return false
    if (!confirms(card, verifier)) return false
    const at = new Date().toISOString()
    await tx
      .update(roomMessages)
      .set({
        parts: {
          ...target.parts,
          proof: {
            ...card,
            verifiedBy: [...card.verifiedBy, { agentId, agentName, ownerName, at }],
          },
        },
      })
      .where(eq(roomMessages.id, cardMessageId))
    return true
  })
  if (!marked) return false
  await postSystemLine(
    roomId,
    `${agentName} (${ownerName}'s agent) independently verified a card's actions.`,
    { kind: "verified", messageId: cardMessageId }
  )
  return true
}

// The bridge task's episode (agents.inbox writes it before the relay runs)
export async function episodeOf(taskId: string) {
  const [row] = await privileged
    .select({
      done: episodes.done,
      unconfirmed: episodes.unconfirmed,
      checks: episodes.checks,
      deletedAt: episodes.deletedAt,
    })
    .from(episodes)
    .where(eq(episodes.taskId, taskId))
  return row && !row.deletedAt ? row : null
}
