import { beforeEach, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

let pg: TestDb
let user: string

async function thread(owner: string, id: string) {
  await asUser(pg, owner, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g') on conflict do nothing",
      [`agent-${owner}`, owner]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
      [id, owner, `agent-${owner}`]
    )
  })
}

async function enqueue(owner: string, threadId: string, extra = "") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd ${extra ? ", max_attempts" : ""})
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000 ${extra ? `, ${extra}` : ""}) returning id`,
    [owner, threadId]
  )
  return rows[0].id
}

async function claim(worker = "w1", lease = 30) {
  const { rows } = await pg.query<{ id: string; attempts: number; user_id: string }>(
    "select * from kriya.claim_task($1, $2)",
    [worker, lease]
  )
  return rows[0] ?? null
}

async function status(id: string) {
  const { rows } = await pg.query<{
    status: string
    attempts: number
    error_code: string | null
  }>("select status, attempts, error_code from kriya.tasks where id = $1", [id])
  return rows[0]
}

beforeEach(async () => {
  pg = await createTestDb()
  user = await createUser(pg)
})

describe("task queue", () => {
  it("allows one active task per thread", async () => {
    await thread(user, "t1")
    await enqueue(user, "t1")
    await expect(enqueue(user, "t1")).rejects.toThrow(/tasks_one_active_per_thread/)
  })

  it("claims a queued task once and leases it", async () => {
    await thread(user, "t1")
    const id = await enqueue(user, "t1")
    const first = await claim("w1")
    expect(first?.id).toBe(id)
    expect(first?.attempts).toBe(1)
    expect(await claim("w2")).toBeNull()
    expect((await status(id)).status).toBe("running")
  })

  it("respects the plan's concurrency limit per user, not across users", async () => {
    const other = await createUser(pg)
    await thread(user, "t1")
    await thread(user, "t2")
    await thread(other, "t3")
    await enqueue(user, "t1")
    await enqueue(user, "t2")
    await enqueue(other, "t3")
    // The free plan runs one task at a time
    const a = await claim()
    const b = await claim()
    const c = await claim()
    expect(a?.user_id).toBe(user)
    expect(b?.user_id).toBe(other)
    expect(c).toBeNull()
  })

  it("heartbeats extend the lease and report cancellation", async () => {
    await thread(user, "t1")
    const id = await enqueue(user, "t1")
    await claim("w1")
    const beat = await pg.query<{ cancel_requested: boolean }>(
      "select * from kriya.heartbeat_task($1, 'w1', 30)",
      [id]
    )
    expect(beat.rows[0].cancel_requested).toBe(false)
    await pg.query("update kriya.tasks set cancel_requested_at = now() where id = $1", [
      id,
    ])
    const again = await pg.query<{ cancel_requested: boolean }>(
      "select * from kriya.heartbeat_task($1, 'w1', 30)",
      [id]
    )
    expect(again.rows[0].cancel_requested).toBe(true)
    // Another worker holds no lease on it
    const stolen = await pg.query("select * from kriya.heartbeat_task($1, 'w2', 30)", [
      id,
    ])
    expect(stolen.rows).toHaveLength(0)
  })

  it("requeues a task whose worker died, with backoff", async () => {
    await thread(user, "t1")
    const id = await enqueue(user, "t1")
    await claim("w1")
    await pg.query(
      "update kriya.tasks set lease_expires_at = now() - interval '1 second' where id = $1",
      [id]
    )
    await pg.query("select kriya.recover_tasks()")
    const row = await status(id)
    expect(row).toMatchObject({ status: "queued", error_code: "worker_lost" })
    // Backoff: not claimable straight away
    expect(await claim()).toBeNull()
  })

  it("fails instead of retrying once something with side effects ran", async () => {
    await thread(user, "t1")
    const id = await enqueue(user, "t1")
    await claim("w1")
    await pg.query(
      `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect)
       values ($1, $2, 1, 'c1', 'send_email', true)`,
      [id, user]
    )
    await pg.query(
      "update kriya.tasks set lease_expires_at = now() - interval '1 second' where id = $1",
      [id]
    )
    await pg.query("select kriya.recover_tasks()")
    expect((await status(id)).status).toBe("failed")
  })

  it("fails a task after its last attempt", async () => {
    await thread(user, "t1")
    const id = await enqueue(user, "t1", "1")
    await claim("w1")
    await pg.query(
      "update kriya.tasks set lease_expires_at = now() - interval '1 second' where id = $1",
      [id]
    )
    await pg.query("select kriya.recover_tasks()")
    expect((await status(id)).status).toBe("failed")
  })

  it("expires queued tasks past their deadline", async () => {
    await thread(user, "t1")
    const id = await enqueue(user, "t1")
    await pg.query(
      "update kriya.tasks set deadline_at = now() - interval '1 second' where id = $1",
      [id]
    )
    await pg.query("select kriya.recover_tasks()")
    expect(await status(id)).toMatchObject({ status: "failed", error_code: "deadline" })
  })

  it("ignores duplicate enqueues with the same idempotency key", async () => {
    await thread(user, "t1")
    await pg.query(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, idempotency_key, status)
       values ($1, 't1', '{}', 'free', 'budget', now(), 10, 1000, 'k1', 'succeeded')`,
      [user]
    )
    await expect(
      pg.query(
        `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, idempotency_key)
         values ($1, 't1', '{}', 'free', 'budget', now(), 10, 1000, 'k1')`,
        [user]
      )
    ).rejects.toThrow(/duplicate key/)
  })
})

describe("usage metering", () => {
  it("records a model request once, however often it's delivered", async () => {
    const insert = () =>
      pg.query(
        `insert into kriya.usage_events (request_key, user_id, provider, model, usage_status, cost_micro_usd)
         values ('task:1:0', $1, 'openrouter', 'm', 'reported', 12) on conflict (request_key) do nothing`,
        [user]
      )
    await insert()
    await insert()
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.usage_events"
    )
    expect(rows[0].n).toBe(1)
  })
})

describe("rate limits", () => {
  it("allows up to the limit per window", async () => {
    const hits: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const { rows } = await pg.query<{ ok: boolean }>(
        "select kriya.hit_rate_limit('login:x', 3, 60) as ok"
      )
      hits.push(rows[0].ok)
    }
    expect(hits).toEqual([true, true, true, false])
  })
})

describe("plans", () => {
  it("falls back to the default plan without a live subscription", async () => {
    const plan = async () =>
      (await pg.query<{ p: string }>("select kriya.effective_plan_id($1) as p", [user]))
        .rows[0].p
    expect(await plan()).toBe("free")
    await pg.query(
      `insert into kriya.subscriptions (user_id, plan_id, status, provider, provider_subscription_id, current_period_end)
       values ($1, 'pro', 'active', 'test', 's1', now() + interval '30 days')`,
      [user]
    )
    expect(await plan()).toBe("pro")
    await pg.query(
      "update kriya.subscriptions set current_period_end = now() - interval '1 day'"
    )
    expect(await plan()).toBe("free")
  })
})
