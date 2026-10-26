import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, describe, expect, it } from "vitest"

import { privileged, setDatabaseForTests, withUser, type DB } from "@/db"
import * as schema from "@/db/schema"
import { assembleContext } from "@/lib/memory/context"
import { rerankByMeaning } from "@/lib/memory/embed"
import { claimJob, enqueueEmbedding, runJob } from "@/lib/memory/maintenance"
import { alwaysOnNotes, queryTokens, recallNotes } from "@/lib/memory/retrieve"
import { updateMemory } from "@/lib/memory/write"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// AS-MEM-ML on PGlite, no model (EVALUATION_PLAN §3; the N9 gate, ND-15):
// AS-MEM's planted notes plus 30 recall cases in Hindi, Telugu, romanised
// Hindi/Telugu, Hinglish and across scripts, on today's recall path (the
// functions run-task.ts calls). M1 = the planted note is always-on or in
// the top 5 recalled. The gate continues to embeddings only if M1 < 0.90.
// A hit is also marked `matched` when the note shares a word with the
// question: a top-5 hit without one came from recency, not relevance.
// With KRIYA_EVAL_OUT=<file> the per-case results are written as JSON.
//
// Paid mode (N9, owner go-ahead NB-05; never in npm test): with
// KRIYA_EVAL_EMBEDDING_MODEL=<model> and OPENROUTER_API_KEY set, each case
// also runs the embed_notes job and reranks the recalled candidates with
// real embeddings, exactly as the runner does, and reports both orders.

const PAID_MODEL = process.env.KRIYA_EVAL_EMBEDDING_MODEL

type Note = {
  key: string
  content: string
  kind: schema.MemoryKind
  slot?: string
  shared?: boolean
  source?: "user"
  ageDays?: number
}
type Case = {
  id: string
  family: string
  query: string
  notes: Note[]
  expect: string[]
  updates?: { key: string; newKey: string; content: string }[]
}

const scenarios = path.join(process.cwd(), "tests", "eval", "scenarios")
const read = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(scenarios, file), "utf8"))
const asMem: Case[] = fs
  .readdirSync(path.join(scenarios, "AS-MEM"))
  .filter((file) => file.startsWith("AS-MEM-") && file.endsWith(".json"))
  .sort()
  .map((file) => read(`AS-MEM/${file}`))
const multilingual: Case[] = (
  read("AS-MEM-ML/AS-MEM-ML.json") as {
    id: string
    family: string
    query: string
    note: { content: string; kind: schema.MemoryKind }
  }[]
).map(({ note, ...rest }) => ({
  ...rest,
  notes: [{ key: "t", ...note, ageDays: 10 }],
  expect: ["t"],
}))
const pool: { content: string; kind: schema.MemoryKind }[] = read("AS-MEM/_pool.json")

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

let pg: TestDb

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
})

// Planted notes among the person's 40 ordinary ones, then the memory blocks
// the runner would build for the question (as tests/eval/memory.eval.test.ts)
async function run(scenario: Case, paid = false) {
  const user = await createUser(pg)
  const agentId = `${scenario.id}-agent`
  await privileged
    .insert(schema.agents)
    .values({ id: agentId, userId: user, name: "Meera", role: "Assistant", glyph: "g" })
  await privileged.insert(schema.memories).values(
    pool.map((note, i) => ({
      id: `${scenario.id}-pool-${i}`,
      userId: user,
      agentId,
      content: note.content,
      kind: note.kind,
      updatedAt: daysAgo(((i * 7) % 90) + 1),
    }))
  )
  const ids = new Map<string, string>()
  for (const note of scenario.notes) {
    const id = `${scenario.id}-${note.key}`
    ids.set(note.key, id)
    await privileged.insert(schema.memories).values({
      id,
      userId: user,
      agentId: note.shared ? null : agentId,
      content: note.content,
      kind: note.kind,
      slot: note.slot ?? null,
      source: note.source ?? "agent",
      updatedAt: daysAgo(note.ageDays ?? 1),
    })
  }
  const env = { userId: user, agentId, taskId: null, untrusted: false }
  for (const update of scenario.updates ?? []) {
    const result = await withUser(user, (tx) =>
      updateMemory(tx, env, ids.get(update.key)!, update.content)
    )
    ids.set(update.newKey, result.id)
  }

  // Paid: the person's confirmed notes get vectors through the real job
  if (paid) {
    await enqueueEmbedding(user)
    for (let job = await claimJob(); job; job = await claimJob()) await runJob(job)
  }
  const { always, candidates } = await withUser(user, async (tx) => {
    const scope = { userId: user, agentId }
    const always = await alwaysOnNotes(tx, scope)
    const candidates = await recallNotes(tx, {
      ...scope,
      query: scenario.query,
      limit: 20,
      exclude: [...always.profile, ...always.standing].map((note) => note.id),
    })
    return { always, candidates }
  })
  const [recalledNotes] = paid
    ? await rerankByMeaning({ userId: user, model: PAID_MODEL!, query: scenario.query }, [
        candidates,
      ])
    : [candidates]
  const { blocks } = assembleContext({
    identity: "",
    ...always,
    recalled: recalledNotes,
    now: new Date(),
    locale: "en-IN",
  })
  // Paid: both calls (the job's and the question's) must have happened, or
  // the rerank silently fell back to today's order
  const embeddingCalls = paid
    ? Number(
        (
          await pg.query<{ n: number }>(
            "select count(*)::int as n from kriya.resource_usage where user_id = $1 and kind = 'embedding_tokens'",
            [user]
          )
        ).rows[0].n
      )
    : 0
  const block = (name: string) => blocks.find((b) => b.name === name)?.ids ?? []
  const alwaysOn = [...block("profile"), ...block("standing")]
  const recalled = block("recalled")
  return {
    id: scenario.id,
    family: scenario.family,
    embeddingCalls,
    hits: scenario.expect.map((key) => {
      const id = ids.get(key)!
      const rank = recalled.indexOf(id)
      const words = new Set(queryTokens(scenario.query))
      const content = [...scenario.notes, ...(scenario.updates ?? [])].find(
        (n) => ("newKey" in n ? n.newKey : n.key) === key
      )!.content
      return {
        key,
        matched: queryTokens(content).some((word) => words.has(word)),
        alwaysOn: alwaysOn.includes(id),
        rank: rank === -1 ? null : rank + 1,
        hit: alwaysOn.includes(id) || (rank !== -1 && rank < 5),
      }
    }),
  }
}

const m1 = (results: Awaited<ReturnType<typeof run>>[]) => {
  const hits = results.flatMap((r) => r.hits)
  return {
    n: hits.length,
    hit: hits.filter((h) => h.hit).length,
    matched: hits.filter((h) => h.hit && h.matched).length,
  }
}

describe("AS-MEM-ML (no model): the N9 gate", () => {
  it("has 30 multilingual cases, six per family", () => {
    expect(multilingual).toHaveLength(30)
    const families = Object.groupBy(multilingual, (c) => c.family)
    expect(
      Object.fromEntries(Object.entries(families).map(([f, c]) => [f, c!.length]))
    ).toEqual({
      hindi: 6,
      telugu: 6,
      romanised: 6,
      cross: 6,
      hinglish: 6,
    })
  })

  it("measures M1 on today's recall", { timeout: 600_000 }, async () => {
    const base: Awaited<ReturnType<typeof run>>[] = []
    for (const scenario of asMem) base.push(await run(scenario))
    const ml: Awaited<ReturnType<typeof run>>[] = []
    for (const scenario of multilingual) ml.push(await run(scenario))

    const byFamily = Object.fromEntries(
      [...new Set(ml.map((r) => r.family))].map((family) => [
        family,
        m1(ml.filter((r) => r.family === family)),
      ])
    )
    const metrics = {
      "AS-MEM": m1(base),
      "AS-MEM-ML": m1([...base, ...ml]),
      multilingualOnly: m1(ml),
      byFamily,
    }
    const out = process.env.KRIYA_EVAL_OUT
    if (out)
      fs.writeFileSync(
        out,
        JSON.stringify({ suite: "AS-MEM-ML", metrics, results: ml }, null, 2)
      )
    console.log(JSON.stringify(metrics))

    // Measured 2026-10-24 on today's code and recorded in status.md (N9):
    // 70/80 = 0.875 < 0.90, so the gate is met. AS-MEM unchanged (40/50).
    // Hindi and Telugu questions about English notes (the "cross" family)
    // hit only through recency: no shared word.
    expect(metrics["AS-MEM"]).toMatchObject({ n: 50, hit: 40 })
    expect(metrics["AS-MEM-ML"]).toMatchObject({ n: 80, hit: 70 })
    expect(metrics["AS-MEM-ML"].hit / metrics["AS-MEM-ML"].n).toBeLessThan(0.9)
    expect(byFamily.cross).toEqual({ n: 6, hit: 6, matched: 1 })
  })
})

describe.skipIf(!PAID_MODEL)("AS-MEM-ML with real embeddings (paid, N9)", () => {
  it("measures M1 with the rerank on", { timeout: 1_800_000 }, async () => {
    process.env.KRIYA_NEXT_MEMORY_RERANK = "on"
    process.env.KRIYA_NEXT_EMBEDDING_MODEL = PAID_MODEL
    process.env.KRIYA_MAINTENANCE_CAP_MICRO_USD = "100000000"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined

    const base: Awaited<ReturnType<typeof run>>[] = []
    for (const scenario of asMem) base.push(await run(scenario, true))
    const ml: Awaited<ReturnType<typeof run>>[] = []
    for (const scenario of multilingual) ml.push(await run(scenario, true))
    const all = [...base, ...ml]
    const spend = (
      await pg.query<{ tokens: string; cost: string | null; unpriced: number }>(
        `select sum(quantity)::text as tokens, sum(cost_micro_usd)::text as cost,
           count(*) filter (where cost_micro_usd is null)::int as unpriced
         from kriya.resource_usage where kind = 'embedding_tokens'`
      )
    ).rows[0]
    const metrics = {
      model: PAID_MODEL,
      "AS-MEM": m1(base),
      "AS-MEM-ML": m1(all),
      multilingualOnly: m1(ml),
      byFamily: Object.fromEntries(
        [...new Set(ml.map((r) => r.family))].map((family) => [
          family,
          m1(ml.filter((r) => r.family === family)),
        ])
      ),
      // Cases where the job or the question's embedding didn't happen
      fellBack: all.filter((r) => r.embeddingCalls < 2).map((r) => r.id),
      spend,
    }
    const out = process.env.KRIYA_EVAL_OUT
    if (out)
      fs.writeFileSync(
        out,
        JSON.stringify({ suite: "AS-MEM-ML paid", metrics, results: all }, null, 2)
      )
    console.log(JSON.stringify(metrics))
    expect(metrics["AS-MEM-ML"].n).toBe(80)
  })
})
