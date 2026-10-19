import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import {
  crossCheckEpisode,
  episodesToCheck,
  inconclusive,
  type Judge,
} from "@/lib/agent/crosscheck"
import { checkCitations } from "@/lib/agent/verify"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// AT-XCK-02: the model cross-check runs only when the deterministic check
// is inconclusive (a cited sentence with no quote), and never on money
// (AD-33, AD-16). The judge is scripted; no model is called.

const SOURCE =
  "GATE 2027 registration closes on 10 October 2026. The application fee is ₹1,800 for general candidates."

const REPLY = [
  'Registration "closes on 10 October 2026" [1].', // quote found: decided
  'The fee is "₹2,500" [1].', // quote not found: decided (unsupported)
  "Registration ends in early October [1].", // paraphrase: inconclusive → model
  "The fee is ₹1,800 for most people [1].", // paraphrase with money: never the model
  "Results come out in March [2].", // source 2 doesn't exist: decided
].join(" ")

let pg: TestDb
let alice: string

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
})

async function episodeWithReply(taskTag: string) {
  const checks = checkCitations(REPLY, [SOURCE])
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g') on conflict do nothing",
    [`a${taskTag}`, alice]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
    [`t${taskTag}`, alice, `a${taskTag}`]
  )
  const { rows: task } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [alice, `t${taskTag}`]
  )
  await pg.query(
    "insert into kriya.messages (thread_id, id, user_id, role, parts, metadata) values ($1, 'm1', $2, 'assistant', $3, $4)",
    [
      `t${taskTag}`,
      alice,
      JSON.stringify([
        { type: "tool-web_fetch", toolCallId: "c1", output: { content: SOURCE } },
        { type: "text", text: REPLY },
      ]),
      JSON.stringify({ taskId: task[0].id }),
    ]
  )
  const { rows } = await pg.query<{ id: string }>(
    "insert into kriya.episodes (user_id, task_id, thread_id, checks, seq, hash) values ($1, $2, $3, $4, 1, 'h') returning id",
    [alice, task[0].id, `t${taskTag}`, JSON.stringify(checks)]
  )
  return {
    id: rows[0].id,
    userId: alice,
    threadId: `t${taskTag}`,
    taskId: task[0].id,
    checks,
  }
}

describe("AT-XCK-02 the model only sees what code can't decide", () => {
  it("picks exactly the quote-less, money-free cited sentence", () => {
    const checks = checkCitations(REPLY, [SOURCE])
    expect(checks.map((c) => c.status)).toEqual([
      "supported",
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
    ])
    expect(inconclusive(checks)).toEqual([
      { sentence: "Registration ends in early October [1].", source: 1 },
    ])
  })

  it("calls the judge once, with only that claim and its source, and stores the verdict", async () => {
    const episode = await episodeWithReply("1")
    const calls: { claim: string; source: string }[] = []
    const judge: Judge = async (input) => {
      calls.push(input)
      return {
        verdict: "supported",
        model: "scripted/judge",
        inputTokens: 50,
        outputTokens: 2,
        costMicroUsd: 20,
      }
    }
    expect(await crossCheckEpisode(episode, { judge })).toBe(1)
    expect(calls).toEqual([
      { claim: "Registration ends in early October [1].", source: SOURCE },
    ])
    const { rows } = await pg.query(
      "select sentence, verdict, model from kriya.claim_checks"
    )
    expect(rows).toEqual([
      {
        sentence: "Registration ends in early October [1].",
        verdict: "supported",
        model: "scripted/judge",
      },
    ])
    const usage = await pg.query(
      "select kind, cost_micro_usd::int as cost from kriya.resource_usage"
    )
    expect(usage.rows).toEqual([{ kind: "maintenance_model", cost: 20 }])
  })

  it("a reply the verbatim check fully decided never reaches the model", async () => {
    const episode = await episodeWithReply("2")
    let called = 0
    const judge: Judge = async () => {
      called++
      return {
        verdict: "supported",
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
      }
    }
    const decided = {
      ...episode,
      checks: episode.checks.filter((c) => !/No quote/.test(c.reason ?? "")),
    }
    expect(await crossCheckEpisode(decided, { judge })).toBe(0)
    // Over the daily cap: nothing is judged
    expect(await crossCheckEpisode(episode, { judge, allowed: async () => false })).toBe(
      0
    )
    expect(called).toBe(0)
  })

  it("lists an episode until it has a verdict", async () => {
    const episode = await episodeWithReply("3")
    const before = new Date(Date.now() - 60_000)
    expect((await episodesToCheck(before)).map((e) => e.id)).toEqual([episode.id])
    await crossCheckEpisode(episode, {
      judge: async () => ({
        verdict: "not_found",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: null,
      }),
    })
    expect(await episodesToCheck(before)).toEqual([])
  })
})
