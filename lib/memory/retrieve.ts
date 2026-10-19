import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"

import { rowsOf, type Q } from "@/db"
import { memories, type Memory } from "@/db/schema"

// Which notes reach the model (MEMORY_AND_CONTEXT.md §5). One SQL query per
// block, no model call. Callers pass a withUser transaction, so Row Level
// Security applies; the explicit user filter is belt and braces.

export type Note = Pick<
  Memory,
  | "id"
  | "agentId"
  | "content"
  | "kind"
  | "slot"
  | "trust"
  | "source"
  | "importance"
  | "pinned"
>

const NOTE_COLUMNS = {
  id: memories.id,
  agentId: memories.agentId,
  content: memories.content,
  kind: memories.kind,
  slot: memories.slot,
  trust: memories.trust,
  source: memories.source,
  importance: memories.importance,
  pinned: memories.pinned,
}

// English, Hinglish and Hindi function words that only add noise to a search
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i i'm in is it its " +
    "me my of on or our s should so t that the their them there they this to was we were what when " +
    "where which who why will with would you your ll re ve d m " +
    "hai hain ka ki ke ko se me mein aur kya kab kaise kyun ho tha thi the nahi bhi to na ye yeh wo " +
    "woh mera meri mere tum aap hum " +
    "है हैं का की के को से में और क्या कब कैसे भी तो ना यह वह"
  ).split(" ")
)
export const MAX_QUERY_TOKENS = 12

// Words of the person's message, safe to hand to to_tsquery as one bound
// parameter: splitting on everything but letters, combining marks and digits
// removes every operator (& | ! ( ) : * '), so text can't change the query
// (AF-17). Marks are kept, or Devanagari and Telugu words would split at
// their vowel signs.
export function queryTokens(text: string) {
  const tokens = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!word || STOP_WORDS.has(word)) continue
    tokens.add(word)
    if (tokens.size === MAX_QUERY_TOKENS) break
  }
  return [...tokens]
}

const tsQuery = (text: string) => {
  const tokens = queryTokens(text)
  return tokens.length > 0 ? tokens.join(" | ") : null
}

// Notes visible to an agent: shared, or its own; current and not archived
const visible = (userId: string, agentId: string) => sql`
  user_id = ${userId} and invalid_at is null and not archived
  and (agent_id is null or agent_id = ${agentId})`

const exclusion = (ids: string[]) =>
  ids.length > 0
    ? sql`and id not in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    : sql``

export type RecalledNote = Note & { score: number }

// The tunable weights of §5.1 (A12: a policy bundle may change them after
// the offline gate). The unconfirmed penalty is a safety rule and stays here.
export type RecallWeights = { recency: number; importance: number; ownAgent: number }
export const RECALL_WEIGHTS: RecallWeights = {
  recency: 0.3,
  importance: 0.2,
  ownAgent: 0.2,
}

// Block 6: the best notes for this turn. score = text match (0..1) + recency
// + importance + own agent − unconfirmed, as in §5.1. Without words in the
// query every candidate scores on the other terms alone, i.e. by recency.
export async function recallNotes(
  tx: Q,
  {
    userId,
    agentId,
    query,
    limit,
    exclude = [],
    weights = RECALL_WEIGHTS,
  }: {
    userId: string
    agentId: string
    query: string
    limit: number
    exclude?: string[]
    weights?: RecallWeights
  }
): Promise<RecalledNote[]> {
  const q = tsQuery(query)
  const rank = q ? sql`ts_rank_cd(search, to_tsquery('simple', ${q}), 32)` : sql`0`
  // Matches first (owner's decision after AS-MEM, 2026-10-18): a note that
  // shares a word with the question always outranks one that doesn't
  const matchesFirst = q ? sql`search @@ to_tsquery('simple', ${q}) desc,` : sql``
  const result = await tx.execute(sql`
    select id, agent_id as "agentId", content, kind, slot, trust, source, importance, pinned,
      (${rank}
        + ${weights.recency}::float8 * exp(greatest(-700, -extract(epoch from now() - coalesce(last_used_at, updated_at)) / 86400.0 / 30))
        + ${weights.importance}::float8 * (importance - 1) / 2.0
        + case when agent_id = ${agentId} then ${weights.ownAgent}::float8 else 0 end
        - case when trust = 'unconfirmed' then 0.3 else 0 end)::float8 as score
    from kriya.memories
    where ${visible(userId, agentId)} ${exclusion(exclude)}
    order by ${matchesFirst} score desc, id
    limit ${limit}`)
  return rowsOf<RecalledNote>(result)
}

// memory_search: notes matching the words of `query`, best match first. With
// `includeHistory`, superseded and forgotten versions too ("what did I say
// before?"), marked as not current.
export async function searchNotes(
  tx: Q,
  {
    userId,
    agentId,
    query,
    kinds,
    includeHistory = false,
    limit,
  }: {
    userId: string
    agentId: string
    query: string
    kinds?: string[]
    includeHistory?: boolean
    limit: number
  }
) {
  const q = tsQuery(query)
  if (!q) return []
  const result = await tx.execute(sql`
    select id, content, kind, slot, trust, source,
      invalid_at is null as current, superseded_by as "supersededBy",
      to_char(valid_from at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as since
    from kriya.memories
    where user_id = ${userId} and (agent_id is null or agent_id = ${agentId})
      ${includeHistory ? sql`` : sql`and invalid_at is null and not archived`}
      ${
        kinds?.length
          ? sql`and kind in (${sql.join(
              kinds.map((kind) => sql`${kind}`),
              sql`, `
            )})`
          : sql``
      }
      and search @@ to_tsquery('simple', ${q})
    order by invalid_at is null desc, ts_rank_cd(search, to_tsquery('simple', ${q}), 32) desc, valid_from desc
    limit ${limit}`)
  return rowsOf<{
    id: string
    content: string
    kind: string
    slot: string | null
    trust: string
    source: string
    current: boolean
    supersededBy: string | null
    since: string
  }>(result)
}

// Up to `limit` current notes that share words with `content`, best match
// first: shown to the agent after memory_write so it can supersede a stale one
export async function similarNotes(
  tx: Q,
  {
    userId,
    agentId,
    content,
    exclude,
    limit = 3,
  }: {
    userId: string
    agentId: string
    content: string
    exclude: string[]
    limit?: number
  }
) {
  const q = tsQuery(content)
  if (!q) return []
  const result = await tx.execute(sql`
    select id, content from kriya.memories
    where ${visible(userId, agentId)} ${exclusion(exclude)}
      and search @@ to_tsquery('simple', ${q})
    order by ts_rank_cd(search, to_tsquery('simple', ${q}), 32) desc, updated_at desc
    limit ${limit}`)
  return rowsOf<{ id: string; content: string }>(result)
}

// Blocks 2 and 3: trusted profile slots, and trusted preferences,
// instructions and pinned notes, newest first. Unconfirmed notes never load
// here (AD-11); they can only be recalled, marked as unconfirmed.
export async function alwaysOnNotes(
  tx: Q,
  { userId, agentId }: { userId: string; agentId: string }
) {
  const rows = await tx
    .select(NOTE_COLUMNS)
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        isNull(memories.invalidAt),
        eq(memories.archived, false),
        eq(memories.trust, "trusted"),
        or(isNull(memories.agentId), eq(memories.agentId, agentId)),
        or(
          and(eq(memories.kind, "profile"), sql`${memories.slot} is not null`),
          inArray(memories.kind, ["preference", "instruction"]),
          eq(memories.pinned, true)
        )
      )
    )
    .orderBy(desc(memories.updatedAt), memories.id)
  const isProfile = (note: Note) => note.kind === "profile" && note.slot !== null
  return {
    profile: rows.filter(isProfile),
    standing: rows.filter((note) => !isProfile(note)),
  }
}
