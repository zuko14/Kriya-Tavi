import { createHash, randomUUID } from "node:crypto"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270301000000_harness.sql (track H, H1): a person sees only their own
// devices, gateway usage, approval requests and mirrored sessions; device
// tokens and sign-in codes are never readable by their session; approval
// requests move only along kriya.allowed_transitions; and the plan's monthly
// harness cap is enforced in SQL before any model call (HT-DB-01…05,
// docs/kriya-harness/DATA_MODEL_AND_STATE_MACHINES.md §6).

let pg: TestDb
let alice: string
let bob: string

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

// The server's inserts (privileged, after authenticateDevice)
async function device(user: string, name = "laptop") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.harness_devices (user_id, name, platform, token_hash)
     values ($1, $2, 'darwin', $3) returning id`,
    [user, name, sha(randomUUID())]
  )
  return rows[0].id
}

async function approval(user: string, deviceId: string, status = "pending") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.harness_approval_requests (user_id, device_id, tool, summary, status, expires_at)
     values ($1, $2, 'shell', 'Run npm test', $3, now() + interval '30 minutes') returning id`,
    [user, deviceId, status]
  )
  return rows[0].id
}

async function thread(user: string, tag: string) {
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g') on conflict do nothing",
    [`agent-${tag}`, user]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
    [`thread-${tag}`, user, `agent-${tag}`]
  )
  return `thread-${tag}`
}

const reserve = (user: string, deviceId: string | null, microInr: number) =>
  pg.query("select kriya.reserve_harness_spend($1, $2, $3, 'budget', 'm/test', $4)", [
    user,
    deviceId,
    `req-${randomUUID()}`,
    microInr,
  ])

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

beforeEach(async () => {
  await pg.query("delete from kriya.harness_usage")
  await pg.query("update kriya.plans set harness_monthly_micro_inr = 0")
})

describe("HT-DB-01: a person's harness rows are theirs alone", () => {
  it("reads only their own; token_hash and sign-in codes are never readable", async () => {
    const d = await device(alice)
    await approval(alice, d)
    const t = await thread(alice, "mirror")
    await pg.query(
      "insert into kriya.harness_sessions (user_id, device_id, thread_id, device_session_id) values ($1, $2, $3, 's1')",
      [alice, d, t]
    )
    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 1000000 where id = 'free'"
    )
    await reserve(alice, d, 1000)
    await pg.query(
      `insert into kriya.harness_device_codes (device_code_hash, user_code, device_name, platform, expires_at)
       values ($1, 'ABCD2345', 'laptop', 'linux', now() + interval '10 minutes')`,
      [sha("code")]
    )

    const count = (tx: Pick<TestDb, "query">, table: string) =>
      tx.query(`select 1 from kriya.${table}`).then((r) => r.rows.length)
    const tables = [
      "harness_devices",
      "harness_approval_requests",
      "harness_sessions",
      "harness_usage",
    ]
    const bobSees = await asUser(pg, bob, async (tx) =>
      Promise.all(tables.map((t) => count(tx, t)))
    )
    expect(bobSees).toEqual([0, 0, 0, 0])
    const aliceSees = await asUser(pg, alice, async (tx) =>
      Promise.all(tables.map((t) => count(tx, t)))
    )
    expect(aliceSees).toEqual([1, 1, 1, 1])
    expect(
      await asUser(pg, alice, (tx) =>
        tx.query(
          "select id, name, platform, mirror, revoked_at from kriya.harness_devices"
        )
      ).then((r) => r.rows)
    ).toEqual([
      { id: d, name: "laptop", platform: "darwin", mirror: "off", revoked_at: null },
    ])

    for (const sql of [
      "select token_hash from kriya.harness_devices",
      "select * from kriya.harness_devices",
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql)),
        sql
      ).rejects.toThrow(/permission denied/)
    }
    // Server only: no grant to any client role, and a no-access policy behind it
    await expect(
      asUser(pg, alice, (tx) => tx.query("select 1 from kriya.harness_device_codes"))
    ).rejects.toThrow(/permission denied/)
  })
})

describe("HT-DB-02: what the person may change", () => {
  it("name, agent, mirror and revoked_at on their devices; nothing else", async () => {
    const d = await device(alice, "old name")
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('agent-h2', $1, 'A', 'r', 'g')",
      [alice]
    )
    const changed = await asUser(pg, alice, (tx) =>
      tx.query(
        `update kriya.harness_devices
         set name = 'work laptop', agent_id = 'agent-h2', mirror = 'summary', revoked_at = now()
         where id = $1 returning id`,
        [d]
      )
    )
    expect(changed.rows).toEqual([{ id: d }])
    expect(
      await asUser(pg, bob, (tx) =>
        tx.query(
          "update kriya.harness_devices set name = 'x' where id = $1 returning id",
          [d]
        )
      ).then((r) => r.rows)
    ).toEqual([])
    for (const sql of [
      `update kriya.harness_devices set token_hash = '${sha("x")}'`,
      "update kriya.harness_devices set user_id = gen_random_uuid()",
      "update kriya.harness_devices set client_version = '9.9.9'",
      "delete from kriya.harness_devices",
      `insert into kriya.harness_devices (user_id, name, platform, token_hash) values ('${alice}', 'n', 'linux', '${sha("y")}')`,
      "update kriya.harness_usage set charge_micro_inr = 0",
      "insert into kriya.harness_device_codes (device_code_hash, user_code, device_name, platform, expires_at) values ('x', 'ABCDEFGH', 'n', 'linux', now())",
      "update kriya.harness_sessions set last_seq = 9",
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql)),
        sql
      ).rejects.toThrow(/permission denied|row-level security/)
    }
  })

  it("status and answered_at on their pending approvals only", async () => {
    const d = await device(alice)
    const a = await approval(alice, d)
    expect(
      await asUser(pg, bob, (tx) =>
        tx.query(
          "update kriya.harness_approval_requests set status = 'approved' where id = $1 returning id",
          [a]
        )
      ).then((r) => r.rows)
    ).toEqual([])
    for (const sql of [
      "update kriya.harness_approval_requests set tool = 'rm'",
      "update kriya.harness_approval_requests set expires_at = now() + interval '1 year'",
      "delete from kriya.harness_approval_requests",
    ]) {
      await expect(
        asUser(pg, alice, (tx) => tx.query(sql)),
        sql
      ).rejects.toThrow(/permission denied/)
    }
    const answered = await asUser(pg, alice, (tx) =>
      tx.query(
        "update kriya.harness_approval_requests set status = 'approved', answered_at = now() where id = $1 returning status",
        [a]
      )
    )
    expect(answered.rows).toEqual([{ status: "approved" }])
    // Answered: no longer pending, so the policy hides it from updates
    expect(
      await asUser(pg, alice, (tx) =>
        tx.query(
          "update kriya.harness_approval_requests set status = 'declined' where id = $1 returning id",
          [a]
        )
      ).then((r) => r.rows)
    ).toEqual([])
  })
})

describe("HT-DB-03: approval requests move only along the allowed transitions", () => {
  it("pending → approved | declined | expired | canceled; answered ones can't change", async () => {
    const d = await device(alice)
    for (const to of ["approved", "declined", "expired", "canceled"]) {
      const a = await approval(alice, d)
      await pg.query(
        "update kriya.harness_approval_requests set status = $1 where id = $2",
        [to, a]
      )
      for (const next of [
        "pending",
        "approved",
        "declined",
        "expired",
        "canceled",
      ].filter((s) => s !== to)) {
        await expect(
          pg.query(
            "update kriya.harness_approval_requests set status = $1 where id = $2",
            [next, a]
          ),
          `${to} → ${next}`
        ).rejects.toThrow()
      }
    }
  })
})

describe("HT-DB-04: the monthly harness cap, in SQL", () => {
  it("counts reserved, settled and estimated rows of the IST month, not failed or older ones", async () => {
    const d = await device(alice)
    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 10000 where id = 'free'"
    )
    await reserve(alice, d, 4000)
    // A settled row counts at its charge, a failed one not at all
    await pg.query(
      "update kriya.harness_usage set status = 'settled', charge_micro_inr = 2000 where user_id = $1",
      [alice]
    )
    await reserve(alice, d, 3000)
    await pg.query(
      `insert into kriya.harness_usage (request_key, user_id, device_id, tier, model, status, reserved_micro_inr)
       values ('failed-1', $1, $2, 'budget', 'm', 'failed', 9000),
              ('estimated-1', $1, $2, 'budget', 'm', 'estimated', 1000)`,
      [alice, d]
    )
    // Last month's spend doesn't count
    await pg.query(
      `insert into kriya.harness_usage (request_key, user_id, device_id, tier, model, status, reserved_micro_inr, charge_micro_inr, created_at)
       values ('old-1', $1, $2, 'budget', 'm', 'settled', 9000, 9000, now() - interval '40 days')`,
      [alice, d]
    )
    // 2000 + 3000 + 1000 = 6000 used of 10000
    await reserve(alice, d, 4000)
    await expect(reserve(alice, d, 1)).rejects.toThrow(/harness cap reached/)
    // Bob's plan is the same, his month is his own
    await expect(reserve(bob, null, 4000)).resolves.toBeDefined()
  })

  it("with room for one, exactly one of two concurrent reservations passes", async () => {
    const d = await device(alice)
    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 5000 where id = 'free'"
    )
    const calls = await Promise.allSettled([
      reserve(alice, d, 3000),
      reserve(alice, d, 3000),
    ])
    expect(calls.map((c) => c.status).sort()).toEqual(["fulfilled", "rejected"])
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.harness_usage where user_id = $1",
      [alice]
    )
    expect(rows[0].n).toBe(1)
  })

  it("no client role may call it", async () => {
    await pg.query(
      "update kriya.plans set harness_monthly_micro_inr = 5000 where id = 'free'"
    )
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query("select kriya.reserve_harness_spend($1, null, 'r', 'budget', 'm', 1)", [
          alice,
        ])
      )
    ).rejects.toThrow(/permission denied/)
  })
})

describe("HT-DB-05: a plan without a harness cap refuses", () => {
  it("cap 0 (every sold plan's default; the owner's internal plan aside)", async () => {
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.plans where harness_monthly_micro_inr <> 0 and id <> 'owner'"
    )
    expect(rows[0].n).toBe(0)
    await expect(reserve(alice, null, 1)).rejects.toThrow(/harness not in plan/)
  })
})
