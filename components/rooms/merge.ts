// Catch-up for the room page (RT-RLT-02): messages arrive by seq from polls
// (and, later, pings); merging is idempotent, keeps seq order and lets a
// newer copy of a message (deleted since) replace the old one.

export const POLL_MS = 10_000

export function mergeMessages<T extends { seq: number }>(have: T[], incoming: T[]) {
  if (incoming.length === 0) return have
  const bySeq = new Map(have.map((m) => [m.seq, m]))
  for (const m of incoming) bySeq.set(m.seq, m)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
