import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { quoteFor } from "@/lib/quotes"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// AT-QUO-01 (K2, AD-28): a quote comes only from real charges of earlier
// tasks of the same workflow, skill or schedule, final or estimated, and
// says "No estimate yet" (null) below 10 samples. It never invents a number.

let pg: TestDb
let alice: string
let bob: string

async function charges(
  user: string,
  input: Record<string, string>,
  rupees: number[],
  status = "final"
) {
  for (const r of rupees) {
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
       values ($1, $2, $3, 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
      [
        user,
        `t-${user}`,
        JSON.stringify({ messageId: "m", agentId: "a", channel: "web", ...input }),
      ]
    )
    await pg.query(
      `insert into kriya.charges (user_id, task_id, plan_id, cost_basis, markup_bps, charge_micro_inr, status)
       values ($1, $2, 'free', 'provider', 10000, $3, $4)`,
      [user, rows[0].id, status === "unpriced" ? null : r * 1_000_000, status]
    )
  }
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  for (const user of [alice, bob]) {
    await asUser(pg, user, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
        [`a-${user}`, user]
      )
      await tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
        [`t-${user}`, user, `a-${user}`]
      )
    })
  }
})

describe("quotes (AT-QUO-01)", () => {
  it("has no estimate under 10 samples, and ignores unpriced charges", async () => {
    await charges(alice, { workflowId: "FD-02" }, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    await charges(alice, { workflowId: "FD-02" }, [100], "unpriced")
    expect(await quoteFor(alice, { workflowId: "FD-02" })).toBeNull()
  })

  it("gives p50 and p90 of the person's own runs, labelled when estimated", async () => {
    await charges(alice, { workflowId: "FD-02" }, [4, 5, 5, 6, 6, 6, 7, 8, 9])
    await charges(alice, { workflowId: "FD-02" }, [12], "estimated")
    expect(await quoteFor(alice, { workflowId: "FD-02" })).toEqual({
      p50MicroInr: 6_000_000,
      p90MicroInr: 9_000_000,
      samples: 10,
      from: "yours",
      estimated: true,
    })
  })

  it("falls back to everyone's runs of a workflow, never of a skill or schedule", async () => {
    await charges(bob, { workflowId: "ST-01" }, [1, 1, 1, 1, 1, 2, 2, 2, 2, 3])
    expect(await quoteFor(alice, { workflowId: "ST-01" })).toMatchObject({
      from: "everyone",
      samples: 10,
      p50MicroInr: 1_000_000,
    })
    await charges(
      bob,
      { skillId: "sk1", scheduleId: "s1" },
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    )
    expect(await quoteFor(alice, { skillId: "sk1" })).toBeNull()
    expect(await quoteFor(alice, { scheduleId: "s1" })).toBeNull()
  })
})
