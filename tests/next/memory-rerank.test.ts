import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, withUser, type DB } from "@/db"
import * as schema from "@/db/schema"
import { fuse, rerankByMeaning, type Embedder } from "@/lib/memory/embed"
import {
  claimJob,
  embeddingModel,
  enqueueEmbedding,
  runJob,
  withinCap,
} from "@/lib/memory/maintenance"
import { exportNotes } from "@/lib/memory/person"
import { recallNotes, type RecalledNote } from "@/lib/memory/retrieve"
import { eraseMemory } from "@/lib/memory/write"
import { getMemories } from "@/queries/workspace"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// N9 past the gate (ND-15): NT-MEM-01 the rerank only reorders; NT-MEM-02 a
// failed embedding leaves today's order; NT-MEM-03 only confirmed, current
// notes get vectors, which never reach a page or the export and go with the
// note; NT-MEM-04 embedding spend is recorded and capped; NT-MEM-05 off or
// without a model nothing is embedded. A fake embedder: no network.

vi.mock("server-only", () => ({}))
const warnings = vi.hoisted(() => [] as string[])
vi.mock("@/lib/log", async (original) => {
  const real = await original<typeof import("@/lib/log")>()
  return {
    ...real,
    log: { ...real.log, warn: (message: string) => warnings.push(message) },
  }
})

const MODEL = "test/embed-64"
// Meaning by topic: words in any script map to the same direction
const TOPICS: [RegExp, number][] = [
  [/rent|किराया|అద్దె/i, 0],
  [/tea|चाय/i, 1],
  [/school|स्कूल|fees/i, 2],
]
const vectorOf = (text: string) => {
  const v: number[] = Array.from({ length: 64 }, (_, i) => (i === 63 ? 0.01 : 0))
  for (const [pattern, axis] of TOPICS) if (pattern.test(text)) v[axis] = 1
  return v
}
const calls: string[][] = []
const fake: Embedder = async (_model, input) => {
  calls.push(input)
  return { vectors: input.map(vectorOf), tokens: input.length * 5, costMicroUsd: 3 }
}
const broken: Embedder = async () => {
  throw new Error("The embedding provider answered 503.")
}

let pg: TestDb
let user: string
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)

const reset = () =>
  ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)
const settings = (rerank: boolean, model: string | null, cap = "100000") => {
  if (rerank) process.env.KRIYA_NEXT_MEMORY_RERANK = "on"
  else delete process.env.KRIYA_NEXT_MEMORY_RERANK
  if (model) process.env.KRIYA_NEXT_EMBEDDING_MODEL = model
  else delete process.env.KRIYA_NEXT_EMBEDDING_MODEL
  process.env.KRIYA_MAINTENANCE_CAP_MICRO_USD = cap
  reset()
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await q(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'A', 'r', 'g')",
    [user]
  )
  await q(
    `insert into kriya.memories (id, user_id, agent_id, content, trust, archived, invalid_at, updated_at) values
      ('rent', $1, 'a1', 'Rent is ₹22,000 a month', 'trusted', false, null, now() - interval '20 days'),
      ('tea', $1, 'a1', 'Likes ginger tea', 'trusted', false, null, now() - interval '2 days'),
      ('school', $1, 'a1', 'School fees are paid every quarter', 'trusted', false, null, now() - interval '9 days'),
      ('maybe', $1, 'a1', 'Rent goes up in May (from an email)', 'unconfirmed', false, null, now()),
      ('old', $1, 'a1', 'Rent was ₹20,000', 'trusted', false, now(), now()),
      ('archived', $1, 'a1', 'Rent in 2024 was ₹18,000', 'trusted', true, null, now())`,
    [user]
  )
  calls.length = 0
  warnings.length = 0
  settings(true, MODEL)
})
afterEach(() => {
  settings(false, null)
  delete process.env.KRIYA_MAINTENANCE_CAP_MICRO_USD
  reset()
})

const runEmbedJob = async (embed: Embedder = fake) => {
  const job = (await claimJob())!
  return runJob(job, undefined, embed)
}
const vectors = async () =>
  (
    await q(
      "select id, embedding_model from kriya.memories where embedding is not null order by id"
    )
  ).rows

describe("NT-MEM-03 which notes get vectors", () => {
  it("only confirmed, current, non-archived notes, without moving their recency", async () => {
    const before = (
      await q("select id, updated_at from kriya.memories where id = 'rent'")
    ).rows[0] as { updated_at: Date }
    await enqueueEmbedding(user)
    expect(await runEmbedJob()).toBe("done")
    expect(await vectors()).toEqual([
      { id: "rent", embedding_model: MODEL },
      { id: "school", embedding_model: MODEL },
      { id: "tea", embedding_model: MODEL },
    ])
    const after = (await q("select updated_at from kriya.memories where id = 'rent'"))
      .rows[0] as {
      updated_at: Date
    }
    expect(new Date(after.updated_at).getTime()).toBe(
      new Date(before.updated_at).getTime()
    )
    // Nothing left to do the second time
    await enqueueEmbedding(user)
    expect(await runEmbedJob()).toBe("nothing")
    expect(calls).toHaveLength(1)
  })

  it("new words drop the old vector; erasing the note erases it", async () => {
    await enqueueEmbedding(user)
    await runEmbedJob()
    await q(
      "update kriya.memories set content = 'Rent is ₹24,000 a month' where id = 'rent'"
    )
    expect((await vectors()).map((r) => (r as { id: string }).id)).toEqual([
      "school",
      "tea",
    ])
    await withUser(user, (tx) => eraseMemory(tx, "tea"))
    expect((await vectors()).map((r) => (r as { id: string }).id)).toEqual(["school"])
  })

  it("no page and no export ever carries a vector", async () => {
    await enqueueEmbedding(user)
    await runEmbedJob()
    const page = await getMemories(user, "a1")
    const exported = await withUser(user, (tx) => exportNotes(tx))
    for (const row of [...page, ...exported])
      expect(Object.keys(row).filter((key) => /embed/i.test(key))).toEqual([])
  })
})

describe("NT-MEM-04 spend", () => {
  it("records embedding tokens and counts them inside the maintenance cap", async () => {
    await enqueueEmbedding(user)
    await runEmbedJob()
    const usage = await q(
      "select kind, quantity, cost_micro_usd from kriya.resource_usage"
    )
    expect(usage.rows).toEqual([
      { kind: "embedding_tokens", quantity: 15, cost_micro_usd: 3 },
    ])
    settings(true, MODEL, "3")
    expect(await withinCap(user)).toBe(false)
  })

  it("over the cap the job waits for tomorrow without calling the provider", async () => {
    settings(true, MODEL, "0")
    await enqueueEmbedding(user)
    expect(await runEmbedJob()).toBe("deferred")
    expect(calls).toEqual([])
  })
})

describe("NT-MEM-05 off", () => {
  it.each([
    ["the switch off", false, MODEL],
    ["no model", true, null],
  ] as const)("with %s nothing is embedded", async (_label, on, model) => {
    settings(on, model)
    expect(await embeddingModel()).toBeNull()
    await enqueueEmbedding(user)
    expect(await runEmbedJob()).toBe("nothing")
    expect(calls).toEqual([])
    expect(await vectors()).toEqual([])
  })
})

describe("NT-MEM-01/02 rerank", () => {
  const QUESTION = "किराया कितना है?"
  const recall = () =>
    withUser(user, (tx) =>
      recallNotes(tx, { userId: user, agentId: "a1", query: QUESTION, limit: 20 })
    )
  const rerank = (lists: RecalledNote[][], embed: Embedder) =>
    rerankByMeaning({ userId: user, model: MODEL, query: QUESTION }, lists, embed)

  it("finds an English note for a Hindi question, keeping the same candidates", async () => {
    await enqueueEmbedding(user)
    await runEmbedJob()
    calls.length = 0
    const today = await recall()
    const [reranked] = await rerank([today], fake)
    expect(reranked.map((n) => n.id).sort()).toEqual(today.map((n) => n.id).sort())
    // No word is shared today; by meaning (fused by reciprocal rank, ND-15)
    // the rent note moves up
    const at = (list: RecalledNote[]) => list.findIndex((n) => n.id === "rent")
    expect(at(today)).toBeGreaterThan(0)
    expect(at(reranked)).toBeLessThan(at(today))
    // One embedding of the question, recorded
    expect(calls).toEqual([[QUESTION]])
    const { rows } = await q(
      "select count(*)::int as n from kriya.resource_usage where kind = 'embedding_tokens'"
    )
    expect(rows).toEqual([{ n: 2 }])
  })

  it("fuse: same set; without vectors or with ties, today's order", () => {
    const notes = ["a", "b", "c"].map((id) => ({ id }) as RecalledNote)
    expect(fuse(notes, new Map(), [1, 0]).map((n) => n.id)).toEqual(["a", "b", "c"])
    const tie = new Map([
      ["a", [1, 0]],
      ["b", [1, 0]],
      ["c", [1, 0]],
    ])
    expect(fuse(notes, tie, [1, 0]).map((n) => n.id)).toEqual(["a", "b", "c"])
    const towardC = new Map([
      ["a", [0, 1]],
      ["b", [0, 1]],
      ["c", [1, 0]],
    ])
    const out = fuse(notes, towardC, [1, 0]).map((n) => n.id)
    expect(out.sort()).toEqual(["a", "b", "c"])
  })

  it("NT-MEM-02: a failed embedding leaves today's order, logged", async () => {
    await enqueueEmbedding(user)
    await runEmbedJob()
    const today = await recall()
    const [failed] = await rerank([today], broken)
    expect(failed).toBe(today)
    expect(warnings).toEqual(["memory rerank failed"])
  })

  it("no vectors yet: no embedding call, today's order", async () => {
    const today = await recall()
    const [same] = await rerank([today], fake)
    expect(same).toBe(today)
    expect(calls).toEqual([])
  })

  it("a failed embedding job writes no vector and no spend", async () => {
    await enqueueEmbedding(user)
    expect(await runEmbedJob(broken)).toBe("rejected")
    expect(await vectors()).toEqual([])
    expect((await q("select 1 from kriya.resource_usage")).rows).toEqual([])
    // Back in the queue for a later attempt
    const { rows } = await q(
      "select status from kriya.maintenance_jobs where kind = 'embed_notes'"
    )
    expect(rows).toEqual([{ status: "queued" }])
  })
})
