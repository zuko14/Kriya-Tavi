import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"

import { privileged, rowsOf, withUser } from "@/db"
import { resourceUsage } from "@/db/schema"
import { getSecret } from "@/lib/config"
import { log } from "@/lib/log"
import { creditsToMicroUsd } from "@/lib/money"

// Memory recall v2's embedding rerank (ND-15, N9). Full-text search still
// picks the candidates; this only reorders them by meaning, so a question
// in Hindi can find a note written in English. Vectors exist only for
// confirmed, current notes (lib/memory/maintenance.ts embed_notes) and are
// read and written here in SQL, never through the Drizzle memories object,
// so no page ever receives one. Embedding calls are a platform cost in
// resource_usage (embedding_tokens), inside the maintenance cap.

export type Embedding = {
  vectors: number[][]
  tokens: number
  // What OpenRouter reported; null when it didn't (never zero for unknown)
  costMicroUsd: number | null
}
export type Embedder = (model: string, input: string[]) => Promise<Embedding>

const TIMEOUT_MS = 20_000

// POST /api/v1/embeddings (OpenRouter API reference, checked 2026-10-24):
// data[].embedding, usage.total_tokens, usage.cost in credits (1 = 1 USD)
export const openRouterEmbed: Embedder = async (model, input) => {
  const apiKey = getSecret("OPENROUTER_API_KEY")
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set on the server.")
  const baseURL = (
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "")
  const response = await fetch(`${baseURL}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": process.env.KRIYA_APP_URL || "https://kriya.ai",
      "X-Title": "Kriya Tavi",
    },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`The embedding provider answered ${response.status}.`)
  const body = (await response.json()) as {
    data?: { embedding?: unknown; index?: number }[]
    usage?: { total_tokens?: number; cost?: unknown }
  }
  const vectors = [...(body.data ?? [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => item.embedding)
  if (
    vectors.length !== input.length ||
    vectors.some(
      (v) =>
        !Array.isArray(v) || v.length < 64 || v.length > 4096 || !v.every(Number.isFinite)
    )
  )
    throw new Error("The embedding provider's answer was malformed.")
  return {
    vectors: vectors as number[][],
    tokens: body.usage?.total_tokens ?? 0,
    costMicroUsd: creditsToMicroUsd(body.usage?.cost),
  }
}

export async function recordEmbedding(
  userId: string,
  requestKey: string,
  result: Embedding
) {
  await privileged
    .insert(resourceUsage)
    .values({
      requestKey,
      userId,
      kind: "embedding_tokens",
      quantity: result.tokens,
      costMicroUsd: result.costMicroUsd,
    })
    .onConflictDoNothing()
}

export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// Reciprocal rank fusion (k = 60) of today's order and similarity to the
// question. Notes without a vector keep only their first term; ties keep
// today's order. The set never changes, only the order.
export function fuse<T extends { id: string }>(
  candidates: T[],
  vectors: Map<string, number[]>,
  query: number[]
) {
  const similar = candidates
    .filter((note) => vectors.has(note.id))
    .map((note) => ({ id: note.id, similarity: cosine(vectors.get(note.id)!, query) }))
    .sort((a, b) => b.similarity - a.similarity)
  const byMeaning = new Map(similar.map((s, i) => [s.id, i + 1]))
  return candidates
    .map((note, i) => {
      const meaning = byMeaning.get(note.id)
      return { note, i, score: 1 / (60 + i + 1) + (meaning ? 1 / (60 + meaning) : 0) }
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ note }) => note)
}

// Each list of recall candidates reordered by meaning: one read of their
// vectors, one embedding of the person's message. Called outside any
// transaction (the provider call can take seconds). Any failure (provider
// down, no key, malformed answer) leaves today's order.
export async function rerankByMeaning<T extends { id: string }>(
  { userId, model, query }: { userId: string; model: string; query: string },
  lists: T[][],
  embed: Embedder = openRouterEmbed
) {
  const ids = [...new Set(lists.flat().map((note) => note.id))]
  if (ids.length < 2 || !query.trim()) return lists
  try {
    const rows = await withUser(userId, async (tx) =>
      rowsOf<{ id: string; embedding: number[] }>(
        await tx.execute(sql`
          select id, embedding from kriya.memories
          where id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `
          )})
            and embedding is not null and embedding_model = ${model}`)
      )
    )
    if (rows.length === 0) return lists
    const asked = await embed(model, [query])
    await recordEmbedding(userId, `embedding:query:${randomUUID()}`, asked)
    const vectors = new Map(rows.map((row) => [row.id, row.embedding]))
    return lists.map((list) => fuse(list, vectors, asked.vectors[0]))
  } catch (error) {
    log.warn("memory rerank failed", { error: (error as Error)?.message ?? "error" })
    return lists
  }
}
