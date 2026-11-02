import { randomUUID } from "node:crypto"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270201000000_cloud_workspaces.sql (track C, C1): workspaces and their
// sessions are visible only to their person, who may only ask to close one;
// statuses move along kriya.allowed_transitions; and plans.workspace_minutes
// and the platform's running cap are enforced in SQL when a session opens
// (CT-DB-01…05, docs/cloud-execution/DATA_MODEL_AND_STATE_MACHINES.md §9).

let pg: TestDb
let alice: string
let bob: string

async function thread(user: string, tag: string) {
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
      [`agent-${tag}`, user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
      [`thread-${tag}`, user, `agent-${tag}`]
    )
  })
  return `thread-${tag}`
}

async function task(user: string, threadId: string) {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [user, threadId]
  )
  return rows[0].id
}

// The worker's insert (privileged); status is set directly, the trigger
// guards only updates
async function workspace(user: string, threadId: string | null, status = "new") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.workspaces (user_id, thread_id, provider, image, size, status)
     values ($1, $2, 'local', 'kriya-runner', '2c-4g', $3) returning id`,
    [user, threadId, status]
  )
  return rows[0].id
}

const open = (taskId: string, workspaceId: string, maxRunning = 100) =>
  pg.query("select kriya.open_workspace_session($1, $2, $3, 'local', $4)", [
    randomUUID(),
    taskId,
    workspaceId,
    maxRunning,
  ])

const openCount = async () =>
  Number(
    (
      await pg.query<{ n: number }>(
        "select count(*)::int as n from kriya.workspace_sessions where status = 'open'"
      )
    ).rows[0].n
  )

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

beforeEach(async () => {
  // Each case starts with no running sandboxes and no metered time
  await pg.query(
    "update kriya.workspace_sessions set status = 'closed' where status = 'open'"
  )
  await pg.query("delete from kriya.resource_usage where kind = 'workspace_seconds'")
  await pg.query("update kriya.plans set workspace_minutes = 0")
})

describe("CT-DB-01: a person's workspaces are theirs alone", () => {
  it("the other person sees and changes nothing; the owner may only ask to close", async () => {
    await pg.query("update kriya.plans set workspace_minutes = 60 where id = 'free'")
    const t = await thread(alice, "rls")
    const w = await workspace(alice, t)
    await open(await task(alice, t), w)

    const seen = await asUser(pg, bob, async (tx) => ({
      workspaces: (await tx.query("select 1 from kriya.workspaces")).rows.length,
      sessions: (await tx.query("select 1 from kriya.workspace_sessions")).rows.length,
      closed: (
        await tx.query(
          "update kriya.workspaces set close_requested_at = now() where id = $1 returning id",
          [w]
        )
      ).rows.length,
    }))
    expect(seen).toEqual({ workspaces: 0, sessions: 0, closed: 0 })

    const mine = await asUser(pg, alice, async (tx) => ({
      workspaces: (await tx.query("select id from kriya.workspaces")).rows,
      sessions: (await tx.query("select workspace_id from kriya.workspace_sessions"))
        .rows,
      closed: (
        await tx.query(
          "update kriya.workspaces set close_requested_at = now() where id = $1 returning id",
          [w]
        )
      ).rows,
    }))
    expect(mine).toEqual({
      workspaces: [{ id: w }],
      sessions: [{ workspace_id: w }],
      closed: [{ id: w }],
    })

    for (const sql of [
      "update kriya.workspaces set status = 'starting'",
      "update kriya.workspaces set user_id = gen_random_uuid()",
      "update kriya.workspaces set generation = 7",
      "update kriya.workspaces set checkpoint_path = 'x'",
      "update kriya.workspace_sessions set status = 'closed'",
      "delete from kriya.workspaces",
      `insert into kriya.workspaces (user_id, provider, image, size) values ('${alice}', 'local', 'i', '2c-4g')`,
      `insert into kriya.workspace_sessions (id, workspace_id, user_id, provider, generation) values (gen_random_uuid(), '${w}', '${alice}', 'local', 0)`,
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql)),
        sql
      ).rejects.toThrow(/permission denied/)
    }
  })

  it("a workspace can't point at another person's thread", async () => {
    const t = await thread(bob, "foreign")
    await expect(workspace(alice, t)).rejects.toThrow(/foreign key/)
  })

  it("a deleted thread leaves the workspace for the janitor", async () => {
    const t = await thread(alice, "gone")
    const w = await workspace(alice, t)
    await pg.query("delete from kriya.threads where id = $1", [t])
    const { rows } = await pg.query(
      "select thread_id, user_id from kriya.workspaces where id = $1",
      [w]
    )
    expect(rows).toEqual([{ thread_id: null, user_id: alice }])
  })

  it("one open workspace per thread; a closed one doesn't count", async () => {
    const t = await thread(alice, "one")
    await workspace(alice, t, "closed")
    await workspace(alice, t)
    await expect(workspace(alice, t)).rejects.toThrow(/workspaces_one_open_per_thread/)
  })
})

describe("CT-DB-02: statuses move only along the allowed transitions", () => {
  const allowed = [
    ["new", "starting"],
    ["starting", "running"],
    ["starting", "failed"],
    ["starting", "paused"],
    ["running", "paused"],
    ["running", "failed"],
    ["running", "closing"],
    ["paused", "starting"],
    ["paused", "closing"],
    ["failed", "starting"],
    ["failed", "closing"],
    ["closing", "closed"],
  ]

  it.each(allowed)("%s → %s passes", async (from, to) => {
    const w = await workspace(alice, null, from)
    await pg.query("update kriya.workspaces set status = $2 where id = $1", [w, to])
  })

  it.each([
    ["new", "running"],
    ["closed", "starting"],
    ["paused", "running"],
  ])("%s → %s raises", async (from, to) => {
    const w = await workspace(alice, null, from)
    await expect(
      pg.query("update kriya.workspaces set status = $2 where id = $1", [w, to])
    ).rejects.toThrow(/workspace can't go from/)
  })

  it("registers exactly the twelve transitions", async () => {
    const { rows } = await pg.query<{ from_status: string; to_status: string }>(
      "select from_status, to_status from kriya.allowed_transitions where entity = 'workspace'"
    )
    expect(rows.map((r) => [r.from_status, r.to_status]).sort()).toEqual(
      [...allowed].sort()
    )
  })
})

describe("CT-DB-03: the plan's minutes, per IST month", () => {
  it("refuses while the plan has no workspace minutes (the default)", async () => {
    const t = await thread(alice, "m0")
    await expect(open(await task(alice, t), await workspace(alice, t))).rejects.toThrow(
      /cloud workspace minutes used up/
    )
  })

  it("counts closed seconds this month and open sessions' elapsed time", async () => {
    await pg.query("update kriya.plans set workspace_minutes = 2 where id = 'free'")
    const t1 = await thread(alice, "m1")
    const task1 = await task(alice, t1)
    // Last month's usage doesn't count
    await pg.query(
      `insert into kriya.resource_usage (request_key, user_id, task_id, kind, quantity, created_at)
       values ('ws:old', $1, $2, 'workspace_seconds', 100000,
         date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' - interval '1 second')`,
      [alice, task1]
    )
    // 60 s metered this month: under 120 s
    await pg.query(
      "insert into kriya.resource_usage (request_key, user_id, task_id, kind, quantity) values ('ws:a', $1, $2, 'workspace_seconds', 60)",
      [alice, task1]
    )
    const w1 = await workspace(alice, t1)
    await open(task1, w1)
    // That open session has been running 60 s: 60 + 60 = 120 s, used up
    await pg.query(
      "update kriya.workspace_sessions set opened_at = now() - interval '60 seconds' where workspace_id = $1",
      [w1]
    )
    const t2 = await thread(alice, "m2")
    await expect(open(await task(alice, t2), await workspace(alice, t2))).rejects.toThrow(
      /cloud workspace minutes used up/
    )
    // Another person's time is theirs alone
    const t3 = await thread(bob, "m3")
    await open(await task(bob, t3), await workspace(bob, t3))
  })
})

describe("CT-DB-04: the platform's running cap", () => {
  it("refuses at p_max_running; with one slot left exactly one of two calls opens", async () => {
    await pg.query("update kriya.plans set workspace_minutes = 600 where id = 'free'")
    const ta = await thread(alice, "c1")
    await open(await task(alice, ta), await workspace(alice, ta))
    const cap = (await openCount()) + 1
    const tb = await thread(alice, "c2")
    const tc = await thread(bob, "c3")
    const calls = await Promise.allSettled([
      open(await task(alice, tb), await workspace(alice, tb), cap),
      open(await task(bob, tc), await workspace(bob, tc), cap),
    ])
    expect(calls.map((c) => c.status).sort()).toEqual(["fulfilled", "rejected"])
    const refused = calls.find((c) => c.status === "rejected") as PromiseRejectedResult
    expect(String(refused.reason)).toMatch(/cloud workspaces are all busy/)
    expect(await openCount()).toBe(cap)
  })
})

describe("CT-DB-05: one person's workspace, one open session", () => {
  it("refuses another person's workspace", async () => {
    await pg.query("update kriya.plans set workspace_minutes = 600 where id = 'free'")
    const tb = await thread(bob, "o1")
    const ta = await thread(alice, "o2")
    await expect(open(await task(bob, tb), await workspace(alice, ta))).rejects.toThrow(
      /another person's workspace/
    )
  })

  it("refuses an unknown task and a second open session for one workspace", async () => {
    await pg.query("update kriya.plans set workspace_minutes = 600 where id = 'free'")
    const t = await thread(alice, "o3")
    const w = await workspace(alice, t)
    await expect(open(randomUUID(), w)).rejects.toThrow(/unknown task/)
    const t1 = await task(alice, t)
    await open(t1, w)
    await expect(open(t1, w)).rejects.toThrow(/workspace_sessions_one_open/)
    const { rows } = await pg.query(
      "select user_id, task_id, generation from kriya.workspace_sessions where workspace_id = $1",
      [w]
    )
    expect(rows).toEqual([{ user_id: alice, task_id: t1, generation: 0 }])
  })

  it("a person can't open sessions themselves", async () => {
    const t = await thread(alice, "o4")
    const w = await workspace(alice, t)
    const t1 = await task(alice, t)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("select kriya.open_workspace_session($1, $2, $3, 'local', 100)", [
          randomUUID(),
          t1,
          w,
        ])
      )
    ).rejects.toThrow(/permission denied/)
  })
})
