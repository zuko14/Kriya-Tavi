import { createHash, randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270401000000_rooms.sql (track R, R1): room data is readable by the
// room's active members only, through the membership functions (no policy
// recursion); people write only as themselves; seq is gap-free; joining goes
// through join_room; only an agent's owner adds it or sets its policy; and
// others' use of an agent is checked in SQL (RT-DB-01…07,
// docs/rooms/DATA_MODEL_AND_STATE_MACHINES.md §8).

let pg: TestDb
let alice: string
let bob: string
let carol: string

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const rows = async (user: string, sql: string, params: unknown[] = []) =>
  asUser(pg, user, (tx) => tx.query<Record<string, unknown>>(sql, params)).then(
    (r) => r.rows
  )
const denied = (user: string, sql: string, params: unknown[] = []) =>
  expect(
    asUser(pg, user, (tx) => tx.query(sql, params)),
    sql
  ).rejects.toThrow(/permission denied|row-level security|violates|not allowed/)

// A room created by its owner (the owner's member row comes from a trigger)
// Refused, or filtered out by the policy so nothing changes: either way no effect
const noEffect = async (user: string, sql: string) => {
  const result = await asUser(pg, user, (tx) => tx.query(sql)).then(
    (r) => r.affectedRows ?? r.rows.length,
    () => 0
  )
  expect(result, sql).toBe(0)
}

async function room(owner: string, title = "Launch plan") {
  const [created] = await rows(
    owner,
    "insert into kriya.rooms (created_by, title) values ($1, $2) returning id",
    [owner, title]
  )
  return created.id as string
}

async function invite(owner: string, roomId: string, token: string, maxUses = 5) {
  await rows(
    owner,
    `insert into kriya.room_invites (room_id, created_by, token_hash, max_uses, expires_at)
     values ($1, $2, $3, $4, now() + interval '2 days')`,
    [roomId, owner, sha(token), maxUses]
  )
}

const join = (user: string, token: string, maxHumans = 25) =>
  asUser(pg, user, (tx) =>
    tx.query<{ id: string }>("select kriya.join_room($1, $2) as id", [
      sha(token),
      maxHumans,
    ])
  ).then((r) => r.rows[0].id)

async function agentWithThread(owner: string, tag: string) {
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
    [`agent-${tag}`, owner]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
    [`bridge-${tag}`, owner, `agent-${tag}`]
  )
  return { agentId: `agent-${tag}`, threadId: `bridge-${tag}` }
}

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  carol = await createUser(pg)
})

describe("RT-DB-01 / -02: a room's rows are its active members' alone", () => {
  it("a non-member sees nothing; a member sees the room; leaving or removal ends it", async () => {
    const r = await room(alice)
    await invite(alice, r, "t-01")
    expect(await join(bob, "t-01")).toBe(r)
    await rows(
      bob,
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'hello')",
      [r, bob]
    )

    const tables = [
      "rooms",
      "room_members",
      "room_messages",
      "room_agents",
      "room_invocations",
      "room_invites",
    ]
    const seen = async (user: string) =>
      Promise.all(
        tables.map(async (t) => (await rows(user, `select 1 from kriya.${t}`)).length)
      )
    expect(await seen(carol)).toEqual([0, 0, 0, 0, 0, 0])
    // Invites: owners and admins only
    expect(await seen(bob)).toEqual([1, 2, 1, 0, 0, 0])
    expect(await seen(alice)).toEqual([1, 2, 1, 0, 0, 1])

    // Bob leaves: nothing more; he can't rejoin with a forged row either
    await rows(
      bob,
      "update kriya.room_members set left_at = now() where room_id = $1 and user_id = $2",
      [r, bob]
    )
    expect(await seen(bob)).toEqual([0, 0, 0, 0, 0, 0])
    await denied(
      bob,
      "insert into kriya.room_members (room_id, user_id) values ($1, $2)",
      [r, bob]
    )

    // Carol joins and is removed by the owner: nothing more, and no way back
    await invite(alice, r, "t-01b")
    await join(carol, "t-01b")
    expect((await seen(carol))[0]).toBe(1)
    await rows(
      alice,
      "update kriya.room_members set left_at = now(), removed_by = $3 where room_id = $1 and user_id = $2",
      [r, carol, alice]
    )
    expect(await seen(carol)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it("members change only their own read marker and leaving; only admins remove; the owner stays", async () => {
    const r = await room(alice, "Roles")
    await invite(alice, r, "t-02")
    await join(bob, "t-02")
    await join(carol, "t-02")
    expect(
      await rows(
        bob,
        "update kriya.room_members set last_read_seq = 3 where room_id = $1 and user_id = $2 returning user_id",
        [r, bob]
      )
    ).toHaveLength(1)
    await denied(
      bob,
      `update kriya.room_members set role = 'admin' where room_id = '${r}' and user_id = '${bob}'`
    )
    for (const sql of [
      `update kriya.room_members set left_at = now(), removed_by = '${bob}' where room_id = '${r}' and user_id = '${carol}'`,
      `update kriya.room_members set left_at = now() where room_id = '${r}' and user_id = '${alice}'`,
    ])
      await noEffect(bob, sql)
    expect(
      (
        await pg.query(
          "select user_id from kriya.room_members where room_id = $1 and left_at is null order by joined_at",
          [r]
        )
      ).rows.length
    ).toBe(3)
    // The owner makes Bob an admin; an admin removes a member but not the owner
    await rows(
      alice,
      "update kriya.room_members set role = 'admin' where room_id = $1 and user_id = $2",
      [r, bob]
    )
    await rows(
      bob,
      "update kriya.room_members set left_at = now(), removed_by = $3 where room_id = $1 and user_id = $2",
      [r, carol, bob]
    )
    await denied(
      bob,
      `update kriya.room_members set left_at = now(), removed_by = '${bob}' where room_id = '${r}' and user_id = '${alice}'`
    )
    await denied(
      bob,
      `update kriya.room_members set role = 'member' where room_id = '${r}' and user_id = '${alice}'`
    )
    await denied(
      alice,
      `update kriya.room_members set left_at = now() where room_id = '${r}' and user_id = '${alice}'`
    )
  })
})

describe("RT-DB-03: people post only as themselves", () => {
  it("human messages as yourself, in your rooms; no forged author, agent or other person", async () => {
    const r = await room(alice, "Posting")
    await invite(alice, r, "t-03")
    await join(bob, "t-03")
    const [mine] = await rows(
      bob,
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'mine') returning id, seq",
      [r, bob]
    )
    expect(Number(mine.seq)).toBe(1)
    for (const sql of [
      `insert into kriya.room_messages (room_id, author_kind, user_id, agent_id, body) values ('${r}', 'agent', '${bob}', 'x', 'forged')`,
      `insert into kriya.room_messages (room_id, author_kind, user_id, body) values ('${r}', 'human', '${alice}', 'as alice')`,
      `insert into kriya.room_messages (room_id, author_kind, body) values ('${r}', 'system', 'system')`,
    ])
      await denied(bob, sql)
    await denied(
      carol,
      `insert into kriya.room_messages (room_id, author_kind, user_id, body) values ('${r}', 'human', '${carol}', 'outsider')`
    )
    // Own message: may be marked deleted, never rewritten; others' untouched
    expect(
      await rows(
        bob,
        "update kriya.room_messages set deleted_at = now() where id = $1 returning id",
        [mine.id]
      )
    ).toHaveLength(1)
    await denied(
      bob,
      `update kriya.room_messages set body = 'edited' where id = '${mine.id}'`
    )
    const [hers] = await rows(
      alice,
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'hers') returning id",
      [r, alice]
    )
    expect(
      await rows(
        bob,
        "update kriya.room_messages set deleted_at = now() where id = $1 returning id",
        [hers.id]
      )
    ).toEqual([])
  })
})

describe("RT-DB-04: seq", () => {
  it("is gap-free and unique under 20 concurrent inserts", async () => {
    const r = await room(alice, "Busy")
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        pg.query(
          "insert into kriya.room_messages (room_id, author_kind, body) values ($1, 'system', $2)",
          [r, `line ${i}`]
        )
      )
    )
    const { rows: seqs } = await pg.query<{ seq: number }>(
      "select seq from kriya.room_messages where room_id = $1 order by seq",
      [r]
    )
    expect(seqs.map((s) => Number(s.seq))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    )
    expect(
      (await pg.query("select last_seq from kriya.rooms where id = $1", [r])).rows[0]
    ).toEqual({ last_seq: 20 })
  })
})

describe("RT-DB-05: join_room", () => {
  it("refuses expired, revoked and used-up invites and full rooms; re-join after leaving; not after removal", async () => {
    const r = await room(alice, "Joining")
    await invite(alice, r, "expired")
    await pg.query(
      "update kriya.room_invites set created_at = now() - interval '3 days', expires_at = now() - interval '1 day' where token_hash = $1",
      [sha("expired")]
    )
    await expect(join(bob, "expired")).rejects.toThrow(/invite/)
    await invite(alice, r, "revoked")
    // token_hash isn't readable by the person: admins revoke by id
    const { rows: revoking } = await pg.query<{ id: string }>(
      "select id from kriya.room_invites where token_hash = $1",
      [sha("revoked")]
    )
    await rows(alice, "update kriya.room_invites set revoked_at = now() where id = $1", [
      revoking[0].id,
    ])
    await expect(join(bob, "revoked")).rejects.toThrow(/invite/)
    await expect(join(bob, "unknown")).rejects.toThrow(/invite/)

    await invite(alice, r, "once", 1)
    expect(await join(bob, "once")).toBe(r)
    // Joining again is a no-op that uses nothing
    expect(await join(bob, "once")).toBe(r)
    await expect(join(carol, "once")).rejects.toThrow(/invite/)

    await invite(alice, r, "full")
    await expect(join(carol, "full", 2)).rejects.toThrow(/full/)

    await rows(
      bob,
      "update kriya.room_members set left_at = now() where room_id = $1 and user_id = $2",
      [r, bob]
    )
    expect(await join(bob, "full")).toBe(r)
    await rows(
      alice,
      "update kriya.room_members set left_at = now(), removed_by = $3 where room_id = $1 and user_id = $2",
      [r, bob, alice]
    )
    await expect(join(bob, "full")).rejects.toThrow(/removed/)

    await rows(alice, "update kriya.rooms set status = 'archived' where id = $1", [r])
    await expect(join(carol, "full")).rejects.toThrow(/archived/)
  })
})

describe("RT-DB-06: an agent in a room is its owner's", () => {
  it("only the owner adds it or sets its policy; letting members use it needs a cap", async () => {
    const r = await room(alice, "Agents")
    await invite(alice, r, "t-06")
    await join(bob, "t-06")
    const a = await agentWithThread(alice, "r6")
    await denied(
      bob,
      `insert into kriya.room_agents (room_id, agent_id, owner_id, bridge_thread_id) values ('${r}', '${a.agentId}', '${alice}', '${a.threadId}')`
    )
    await denied(
      bob,
      `insert into kriya.room_agents (room_id, agent_id, owner_id, bridge_thread_id) values ('${r}', '${a.agentId}', '${bob}', '${a.threadId}')`
    )
    // Not a member: can't add one of their own agents either
    const c = await agentWithThread(carol, "r6c")
    await denied(
      carol,
      `insert into kriya.room_agents (room_id, agent_id, owner_id, bridge_thread_id) values ('${r}', '${c.agentId}', '${carol}', '${c.threadId}')`
    )

    await rows(
      alice,
      "insert into kriya.room_agents (room_id, agent_id, owner_id, bridge_thread_id) values ($1, $2, $3, $4)",
      [r, a.agentId, alice, a.threadId]
    )
    expect(await rows(bob, "select agent_id, invoke from kriya.room_agents")).toEqual([
      { agent_id: a.agentId, invoke: "owner_only" },
    ])
    await denied(
      alice,
      `update kriya.room_agents set invoke = 'members' where room_id = '${r}'`
    )
    await rows(
      alice,
      "update kriya.room_agents set invoke = 'members', daily_cap_micro_inr = 50000000 where room_id = $1",
      [r]
    )
    expect(
      await rows(
        bob,
        "update kriya.room_agents set invoke = 'owner_only' where room_id = $1 returning agent_id",
        [r]
      )
    ).toEqual([])
    await denied(
      alice,
      `update kriya.room_agents set owner_id = '${bob}' where room_id = '${r}'`
    )
  })
})

describe("RT-DB-07: check_room_invocation", () => {
  it("refuses non-members, non-owners under owner_only, over-cap use, a busy agent and a paused room", async () => {
    const r = await room(alice, "Invoking")
    await invite(alice, r, "t-07")
    await join(bob, "t-07")
    const a = await agentWithThread(alice, "r7")
    await pg.query(
      "insert into kriya.room_agents (room_id, agent_id, owner_id, bridge_thread_id) values ($1, $2, $3, $4)",
      [r, a.agentId, alice, a.threadId]
    )
    const check = (requester: string, agent = a.agentId) =>
      pg
        .query<{ v: string }>(
          "select kriya.check_room_invocation($1, $2, $3, date_trunc('day', now())) as v",
          [r, agent, requester]
        )
        .then((res) => res.rows[0].v)

    expect(await check(alice)).toBe("ok")
    expect(await check(carol)).toBe("not_member")
    expect(await check(bob)).toBe("owner_only")
    expect(await check(alice, "agent-missing")).toBe("agent_not_in_room")

    await pg.query(
      "update kriya.room_agents set invoke = 'members', daily_cap_micro_inr = 1000 where room_id = $1",
      [r]
    )
    expect(await check(bob)).toBe("ok")
    // Bob's earlier request today cost the cap (charged to Alice's task)
    const { rows: tasks } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, agent_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
       values ($1, $2, $3, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
      [alice, a.threadId, a.agentId]
    )
    await pg.query(
      `insert into kriya.room_invocations (room_id, agent_id, owner_id, requested_by, task_id, status) values ($1, $2, $3, $4, $5, 'done')`,
      [r, a.agentId, alice, bob, tasks[0].id]
    )
    await pg.query(
      `insert into kriya.charges (user_id, task_id, plan_id, provider_cost_micro_usd, cost_basis, markup_bps, status, charge_micro_inr)
       values ($1, $2, 'free', 10, 'provider', 10000, 'final', 1000)`,
      [alice, tasks[0].id]
    )
    expect(await check(bob)).toBe("over_cap")
    // The owner's own requests aren't capped
    expect(await check(alice)).toBe("ok")

    await pg.query(
      "insert into kriya.room_invocations (room_id, agent_id, owner_id, requested_by, status) values ($1, $2, $3, $3, 'queued')",
      [r, a.agentId, alice]
    )
    expect(await check(alice)).toBe("busy")
    await pg.query(
      "update kriya.room_invocations set status = 'done' where status = 'queued'"
    )
    await pg.query(
      "update kriya.rooms set agents_paused_until = now() + interval '1 hour' where id = $1",
      [r]
    )
    expect(await check(alice)).toBe("paused")

    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("select kriya.check_room_invocation($1, $2, $3, now())", [
          r,
          a.agentId,
          alice,
        ])
      )
    ).rejects.toThrow(/permission denied/)
  })
})

describe("RT-DB-03b: disclosures are their owner's", () => {
  it("only the owner sees and answers a pending disclosure, once", async () => {
    const r = await room(alice, "Disclosing")
    await invite(alice, r, "t-03b")
    await join(bob, "t-03b")
    const { rows: d } = await pg.query<{ id: string }>(
      "insert into kriya.room_disclosures (room_id, owner_id, agent_id, body) values ($1, $2, 'agent-x', 'private summary') returning id",
      [r, alice]
    )
    expect(await rows(bob, "select 1 from kriya.room_disclosures")).toEqual([])
    expect(
      await rows(
        alice,
        "update kriya.room_disclosures set status = 'shared', answered_at = now() where id = $1 returning status",
        [d[0].id]
      )
    ).toEqual([{ status: "shared" }])
    expect(
      await rows(
        alice,
        "update kriya.room_disclosures set status = 'discarded' where id = $1 returning id",
        [d[0].id]
      )
    ).toEqual([])
    await denied(
      alice,
      `update kriya.room_disclosures set body = 'x' where id = '${d[0].id}'`
    )
    await expect(
      pg.query("update kriya.room_disclosures set status = 'pending' where id = $1", [
        d[0].id,
      ])
    ).rejects.toThrow()
    void randomUUID
  })
})

// 20270401000100_room_goals_notes.sql (R7, R8's table): goals, their items
// and notes are room data like the rest; an item closes only with a
// verified action on a proof card in the same room, or a member's own
// confirmation; a goal's status is the server's (RT-GOAL-03)
describe("RT-GOAL-03: goals, items and notes", () => {
  // An agent's message with a proof card: action 0 verified, action 1 not
  const card = async (roomId: string, owner: string) =>
    (
      await pg.query<{ id: string }>(
        `insert into kriya.room_messages (room_id, author_kind, user_id, agent_id, body, parts)
         values ($1, 'agent', $2, 'agent-x', 'Done', $3) returning id`,
        [
          roomId,
          owner,
          JSON.stringify({
            proof: {
              kind: "proof",
              done: [
                {
                  title: "Opened a PR",
                  status: "verified",
                  method: "api_readback",
                  evidence: [],
                },
                {
                  title: "Updated a sheet",
                  status: "unverified",
                  method: "none",
                  evidence: [],
                },
              ],
              unconfirmed: 0,
              checks: { supported: 0, unsupported: 0 },
              verifiedBy: [],
            },
          }),
        ]
      )
    ).rows[0].id

  async function goalIn(roomId: string, user: string) {
    const [goal] = await rows(
      user,
      "insert into kriya.room_goals (room_id, title, created_by) values ($1, 'Launch ready', $2) returning id",
      [roomId, user]
    )
    const [item] = await rows(
      user,
      "insert into kriya.room_goal_items (goal_id, room_id, text, created_by) values ($1, $2, 'PR merged', $3) returning id",
      [goal.id, roomId, user]
    )
    return { goalId: goal.id as string, itemId: item.id as string }
  }

  it("members only; status isn't theirs to set", async () => {
    const r = await room(alice, "Goals room")
    await invite(alice, r, "t-g1")
    await join(bob, "t-g1")
    const { goalId } = await goalIn(r, bob)
    expect(await rows(carol, "select 1 from kriya.room_goals")).toEqual([])
    expect(await rows(carol, "select 1 from kriya.room_goal_items")).toEqual([])
    expect(
      await rows(alice, "select title from kriya.room_goals where id = $1", [goalId])
    ).toEqual([{ title: "Launch ready" }])
    await denied(
      bob,
      `update kriya.room_goals set status = 'done' where id = '${goalId}'`
    )
    await denied(
      carol,
      `insert into kriya.room_goals (room_id, title, created_by) values ('${r}', 'x', '${carol}')`
    )
    // Adding as someone else
    await denied(
      bob,
      `insert into kriya.room_goal_items (goal_id, room_id, text, created_by) values ('${goalId}', '${r}', 'x', '${alice}')`
    )
  })

  it("closes only with a verified action on a card in this room, or one's own confirmation", async () => {
    const r = await room(alice, "Proof room")
    await invite(alice, r, "t-g2")
    await join(bob, "t-g2")
    const other = await room(alice, "Other room")
    const { itemId } = await goalIn(r, bob)
    const here = await card(r, alice)
    const elsewhere = await card(other, alice)

    await denied(
      bob,
      `update kriya.room_goal_items set proof_message_id = '${elsewhere}', proof_item = 0 where id = '${itemId}'`
    )
    await denied(
      bob,
      `update kriya.room_goal_items set proof_message_id = '${here}', proof_item = 1 where id = '${itemId}'`
    )
    await denied(
      bob,
      `update kriya.room_goal_items set confirmed_by = '${alice}' where id = '${itemId}'`
    )
    // The client can't fake a closed item
    await denied(
      bob,
      `update kriya.room_goal_items set closed_at = now() where id = '${itemId}'`
    )

    const [closed] = await rows(
      bob,
      `update kriya.room_goal_items set proof_message_id = $1, proof_item = 0 where id = $2
       returning closed_at`,
      [here, itemId]
    )
    expect(closed.closed_at).not.toBeNull()
    // Reopened: closed_at goes with the proof
    const [open] = await rows(
      bob,
      "update kriya.room_goal_items set proof_message_id = null, proof_item = null where id = $1 returning closed_at",
      [itemId]
    )
    expect(open.closed_at).toBeNull()
    const [confirmed] = await rows(
      bob,
      "update kriya.room_goal_items set confirmed_by = $1 where id = $2 returning closed_at",
      [bob, itemId]
    )
    expect(confirmed.closed_at).not.toBeNull()
    // A non-member changes nothing
    await noEffect(
      carol,
      `update kriya.room_goal_items set text = 'x' where id = '${itemId}'`
    )
  })

  it("notes: members add their own, confirm agents' as themselves, delete only their own", async () => {
    const r = await room(alice, "Notes room")
    await invite(alice, r, "t-g3")
    await join(bob, "t-g3")
    const [mine] = await rows(
      bob,
      "insert into kriya.room_notes (room_id, body, author_kind, user_id) values ($1, 'Venue: Hall B', 'human', $2) returning id",
      [r, bob]
    )
    await denied(
      bob,
      `insert into kriya.room_notes (room_id, body, author_kind, user_id, agent_id) values ('${r}', 'x', 'agent', '${bob}', 'a')`
    )
    await denied(
      bob,
      `insert into kriya.room_notes (room_id, body, author_kind, user_id) values ('${r}', 'x', 'human', '${alice}')`
    )
    // An agent's note, as the worker writes it (R8)
    const { rows: agentNote } = await pg.query<{ id: string }>(
      "insert into kriya.room_notes (room_id, body, author_kind, user_id, agent_id) values ($1, 'Budget ₹2 lakh', 'agent', $2, 'agent-x') returning id",
      [r, alice]
    )
    await denied(
      bob,
      `update kriya.room_notes set confirmed_by = '${alice}', confirmed_at = now() where id = '${agentNote[0].id}'`
    )
    expect(
      await rows(
        bob,
        "update kriya.room_notes set confirmed_by = $1, confirmed_at = now() where id = $2 returning confirmed_by",
        [bob, agentNote[0].id]
      )
    ).toEqual([{ confirmed_by: bob }])
    await denied(
      alice,
      `update kriya.room_notes set deleted_at = now() where id = '${mine.id}'`
    )
    expect(await rows(carol, "select 1 from kriya.room_notes")).toEqual([])
  })
})

describe("RT-GOAL-03: deleting an account", () => {
  it("isn't blocked by items the person confirmed or proved; those items reopen", async () => {
    const dana = await createUser(pg)
    const r = await room(alice, "Deletion room")
    await invite(alice, r, "t-g4")
    await join(dana, "t-g4")
    const [goal] = await rows(
      dana,
      "insert into kriya.room_goals (room_id, title, created_by) values ($1, 'G', $2) returning id",
      [r, dana]
    )
    const [added] = await rows(
      dana,
      "insert into kriya.room_goal_items (goal_id, room_id, text, created_by) values ($1, $2, 'x', $3) returning id",
      [goal.id, r, dana]
    )
    const [item] = await rows(
      dana,
      "update kriya.room_goal_items set confirmed_by = $1 where id = $2 returning id, closed_at",
      [dana, added.id]
    )
    expect(item.closed_at).not.toBeNull()
    await pg.query("delete from auth.users where id = $1", [dana])
    const { rows: after } = await pg.query(
      "select confirmed_by, closed_at from kriya.room_goal_items where id = $1",
      [item.id]
    )
    expect(after).toEqual([{ confirmed_by: null, closed_at: null }])
  })
})

// 20270401000200_room_moderation.sql (R9): blocks are the blocker's own;
// reports go in only from members, with the message copied by the database
describe("RT-MOD-02 / -03: blocks and reports", () => {
  it("a block is seen, added and removed only by the person who made it", async () => {
    await rows(
      alice,
      "insert into kriya.person_blocks (blocker_id, blocked_id) values ($1, $2)",
      [alice, bob]
    )
    expect(await rows(alice, "select blocked_id from kriya.person_blocks")).toEqual([
      { blocked_id: bob },
    ])
    // Bob can't see that Alice blocked him, nor block as her, nor remove it
    expect(await rows(bob, "select * from kriya.person_blocks")).toEqual([])
    await denied(
      bob,
      "insert into kriya.person_blocks (blocker_id, blocked_id) values ($1, $2)",
      [alice, carol]
    )
    await noEffect(bob, `delete from kriya.person_blocks where blocker_id = '${alice}'`)
    await denied(
      alice,
      "insert into kriya.person_blocks (blocker_id, blocked_id) values ($1, $1)",
      [alice]
    )
    await rows(alice, "delete from kriya.person_blocks where blocked_id = $1", [bob])
    expect(await rows(alice, "select * from kriya.person_blocks")).toEqual([])
  })

  it("invite_blocked names only the caller's block or the maker's block of the caller", async () => {
    const roomId = await room(alice, "Blocks")
    await invite(alice, roomId, "block-token")
    const check = (user: string) =>
      rows(user, "select kriya.invite_blocked($1) as b", [sha("block-token")]).then(
        (r) => r[0].b
      )
    expect(await check(bob)).toBeNull()
    await pg.query("insert into kriya.person_blocks values ($1, $2)", [bob, alice])
    expect(await check(bob)).toBe("joiner")
    expect(await check(carol)).toBeNull()
    await pg.query("insert into kriya.person_blocks values ($1, $2)", [alice, carol])
    expect(await check(carol)).toBe("maker")
    await pg.query("delete from kriya.person_blocks")
  })

  it("members report as themselves; the message is copied; only the reporter reads it", async () => {
    const roomId = await room(alice, "Reports")
    await invite(alice, roomId, "report-token")
    await join(bob, "report-token")
    const [message] = await rows(
      bob,
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'buy now') returning id",
      [roomId, bob]
    )
    // A client can't fill the copy or the review itself
    await denied(
      alice,
      "insert into kriya.room_reports (room_id, message_id, reporter_id, reason, message_body) values ($1, $2, $3, 'spam', 'made up')",
      [roomId, message.id, alice]
    )
    await denied(
      alice,
      "insert into kriya.room_reports (room_id, message_id, reporter_id, reason, status) values ($1, $2, $3, 'spam', 'reviewed')",
      [roomId, message.id, alice]
    )
    const [report] = await rows(
      alice,
      "insert into kriya.room_reports (room_id, message_id, reporter_id, reason, note) values ($1, $2, $3, 'spam', 'ads') returning id, message_body, message_user_id, status",
      [roomId, message.id, alice]
    )
    expect(report).toMatchObject({
      message_body: "buy now",
      message_user_id: bob,
      status: "open",
    })
    // Once per person while open
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.room_reports (room_id, message_id, reporter_id, reason) values ($1, $2, $3, 'spam')",
          [roomId, message.id, alice]
        )
      )
    ).rejects.toThrow(/room_reports_once|duplicate/)
    // Not as someone else, not from outside the room, not a message of another room
    await denied(
      bob,
      "insert into kriya.room_reports (room_id, reporter_id, reason) values ($1, $2, 'spam')",
      [roomId, alice]
    )
    await denied(
      carol,
      "insert into kriya.room_reports (room_id, reporter_id, reason) values ($1, $2, 'spam')",
      [roomId, carol]
    )
    const other = await room(bob, "Other")
    await denied(
      bob,
      "insert into kriya.room_reports (room_id, message_id, reporter_id, reason) values ($1, $2, $3, 'spam')",
      [other, message.id, bob]
    )
    // Reading: the reporter alone; nobody reviews through the session
    expect(await rows(alice, "select id from kriya.room_reports")).toEqual([
      { id: report.id },
    ])
    expect(
      await rows(bob, "select id from kriya.room_reports where room_id = $1", [roomId])
    ).toEqual([])
    await denied(
      alice,
      `update kriya.room_reports set status = 'dismissed' where id = '${report.id}'`
    )
    // The server's review follows the transitions
    await pg.query("update kriya.room_reports set status = 'reviewed' where id = $1", [
      report.id,
    ])
    await expect(
      pg.query("update kriya.room_reports set status = 'open' where id = $1", [report.id])
    ).rejects.toThrow()
  })

  it("a deleted message is reported without its text", async () => {
    const roomId = await room(carol, "Deleted")
    const [message] = await rows(
      carol,
      "insert into kriya.room_messages (room_id, author_kind, user_id, body) values ($1, 'human', $2, 'gone soon') returning id",
      [roomId, carol]
    )
    await rows(carol, "update kriya.room_messages set deleted_at = now() where id = $1", [
      message.id,
    ])
    const [report] = await rows(
      carol,
      "insert into kriya.room_reports (room_id, message_id, reporter_id, reason) values ($1, $2, $3, 'other') returning message_body, message_author_kind",
      [roomId, message.id, carol]
    )
    expect(report).toEqual({ message_body: null, message_author_kind: "human" })
  })
})
