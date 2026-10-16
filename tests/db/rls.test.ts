import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

let pg: TestDb
let alice: string
let bob: string

// Alice's content, created through her own session
async function seed(user: string, tag: string) {
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
      [`agent-${tag}`, user]
    )
    await tx.query("insert into kriya.squads (id, user_id, name) values ($1, $2, 'S')", [
      `squad-${tag}`,
      user,
    ])
    await tx.query(
      "insert into kriya.squad_members (squad_id, agent_id, user_id) values ($1, $2, $3)",
      [`squad-${tag}`, `agent-${tag}`, user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
      [`thread-${tag}`, user, `agent-${tag}`]
    )
    await tx.query(
      "insert into kriya.messages (thread_id, id, user_id, role, parts) values ($1, 'm1', $2, 'user', '[]')",
      [`thread-${tag}`, user]
    )
    await tx.query(
      "insert into kriya.memories (id, user_id, agent_id, content) values ($1, $2, $3, 'likes tea')",
      [`memory-${tag}`, user, `agent-${tag}`]
    )
  })
}

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  await seed(alice, "a")
  await seed(bob, "b")
})

const OWNED = ["agents", "squads", "squad_members", "threads", "messages", "memories"]

describe("row level security", () => {
  it("creates a profile for every new user", async () => {
    const { rows } = await pg.query("select id from kriya.profiles where id = $1", [
      alice,
    ])
    expect(rows).toHaveLength(1)
  })

  it.each(OWNED)("%s: a user only sees their own rows", async (table) => {
    const rows = await asUser(pg, alice, async (tx) => {
      const { rows } = await tx.query<{ user_id: string }>(
        `select user_id from kriya.${table}`
      )
      return rows
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.user_id === alice)).toBe(true)
  })

  it.each(OWNED)("%s: a user can't update or delete another's rows", async (table) => {
    const result = await asUser(pg, alice, async (tx) => {
      const updated = await tx.query(
        `update kriya.${table} set user_id = user_id where user_id = $1`,
        [bob]
      )
      const deleted = await tx.query(`delete from kriya.${table} where user_id = $1`, [
        bob,
      ])
      return { updated: updated.affectedRows, deleted: deleted.affectedRows }
    })
    expect(result).toEqual({ updated: 0, deleted: 0 })
    const { rows } = await pg.query(
      `select count(*)::int as n from kriya.${table} where user_id = $1`,
      [bob]
    )
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0)
  })

  it("refuses rows written in someone else's name", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.agents (id, user_id, name, role, glyph) values ('x', $1, 'X', 'r', 'g')",
          [bob]
        )
      )
    ).rejects.toThrow(/row-level security/)
  })

  it("refuses moving a row to another user", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.agents set user_id = $1 where id = 'agent-a'", [bob])
      )
    ).rejects.toThrow()
  })

  it("won't put another user's agent in a squad, or open a thread with it", async () => {
    // Alice names Bob's agent while claiming the row as her own
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.squad_members (squad_id, agent_id, user_id) values ('squad-a', 'agent-b', $1)",
          [alice]
        )
      )
    ).rejects.toThrow()
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.threads (id, user_id, agent_id) values ('t-x', $1, 'agent-b')",
          [alice]
        )
      )
    ).rejects.toThrow()
  })

  it("won't overwrite another user's message through a colliding id", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.messages (thread_id, id, user_id, role, parts) values ('thread-b', 'm1', $1, 'user', '[]')",
          [alice]
        )
      )
    ).rejects.toThrow()
  })

  it("lets users edit their profile but not their status", async () => {
    await asUser(pg, alice, (tx) =>
      tx.query("update kriya.profiles set display_name = 'Alice' where id = $1", [alice])
    )
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.profiles set status = 'active' where id = $1", [alice])
      )
    ).rejects.toThrow(/permission denied/)
    const bobs = await asUser(pg, alice, (tx) =>
      tx.query("update kriya.profiles set display_name = 'x' where id = $1", [bob])
    )
    expect(bobs.affectedRows).toBe(0)
  })

  it("keeps platform tables closed to users", async () => {
    for (const table of [
      "platform_roles",
      "platform_settings",
      "audit_events",
      "billing_events",
      "models",
      "workers",
      "rate_limits",
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(`select * from kriya.${table}`))
      ).rejects.toThrow(/permission denied/)
    }
  })

  it("never lets users write tasks, usage or charges themselves", async () => {
    for (const sql of [
      "insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd) values (auth.uid(), 'thread-a', '{}', 'pro', 'escalation', now(), 200, 1)",
      "insert into kriya.usage_events (request_key, user_id, provider, model, usage_status) values ('k', auth.uid(), 'p', 'm', 'reported')",
      "insert into kriya.subscriptions (user_id, plan_id, status, provider, provider_subscription_id) values (auth.uid(), 'pro', 'active', 'test', 'x')",
      "update kriya.plans set price_monthly_paise = 0",
    ]) {
      await expect(asUser(pg, alice, (tx) => tx.query(sql))).rejects.toThrow(
        /permission denied/
      )
    }
  })

  it("connections: shows a user their own accounts but never the tokens", async () => {
    // Written by the server (privileged), as lib/connectors.ts does
    for (const [user, tag] of [
      [alice, "a"],
      [bob, "b"],
    ]) {
      await pg.query(
        "insert into kriya.connections (id, user_id, provider, account, access_token) values ($1, $2, 'google', $3, 'v1.sealed')",
        [`conn-${tag}`, user, `${tag}@example.com`]
      )
    }
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query<{ account: string }>("select account from kriya.connections")
    )
    expect(rows).toEqual([{ account: "a@example.com" }])
    for (const column of ["access_token", "refresh_token"]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(`select ${column} from kriya.connections`))
      ).rejects.toThrow(/permission denied/)
    }
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.connections (id, user_id, provider, access_token) values ('x', auth.uid(), 'notion', 'forged')"
        )
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("update kriya.connections set account = 'x' where id = 'conn-a'")
      )
    ).rejects.toThrow(/permission denied/)

    // Deleting works on their own row only
    const deleted = await asUser(pg, alice, async (tx) => ({
      bobs: (await tx.query("delete from kriya.connections where id = 'conn-b'"))
        .affectedRows,
      own: (await tx.query("delete from kriya.connections where id = 'conn-a'"))
        .affectedRows,
    }))
    expect(deleted).toEqual({ bobs: 0, own: 1 })
  })

  it("shows users only active plans", async () => {
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query<{ id: string }>("select id from kriya.plans")
    )
    expect(rows.map((row) => row.id)).toEqual(["free"])
  })

  it("deleting an agent removes its threads and their tasks, under RLS", async () => {
    const carol = await createUser(pg)
    await seed(carol, "c")
    await pg.query(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 'thread-c', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000)`,
      [carol]
    )
    await asUser(pg, carol, (tx) =>
      tx.query("delete from kriya.agents where id = 'agent-c'")
    )
    const { rows } = await pg.query<{ n: number }>(
      "select (select count(*) from kriya.threads where user_id = $1)::int + (select count(*) from kriya.tasks where user_id = $1)::int as n",
      [carol]
    )
    expect(rows[0].n).toBe(0)
  })

  it("only shows a user their own task records", async () => {
    await pg.query(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, 'thread-b', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000)`,
      [bob]
    )
    const { rows } = await asUser(pg, alice, (tx) =>
      tx.query("select * from kriya.tasks")
    )
    expect(rows).toHaveLength(0)
  })
})
