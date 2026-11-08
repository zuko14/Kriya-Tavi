import { randomUUID } from "node:crypto"

import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// ET-DB-01…04 and -06: Row Level Security on the track E tables, and the preview
// limit in SQL. PGlite has one connection, so "concurrent" here means calls
// interleaved in one session: the advisory lock itself needs real Postgres.

let pg: TestDb
let alice: string
let bob: string
let aliceDevice: string
let bobDevice: string
let job: string

const device = async (user: string) =>
  (
    await pg.query<{ id: string }>(
      `insert into kriya.harness_devices (user_id, name, platform, token_hash)
       values ($1, 'laptop', 'darwin', $2) returning id`,
      [user, randomUUID().replaceAll("-", "").padEnd(64, "0")]
    )
  ).rows[0].id

const dispatch = async (user: string, deviceId: string) =>
  (
    await pg.query<{ id: string }>(
      `insert into kriya.harness_dispatches (user_id, device_id, kind) values ($1, $2, 'edit') returning id`,
      [user, deviceId]
    )
  ).rows[0].id

const newJob = async (user: string, deviceId: string) => {
  const id = randomUUID()
  await pg.query(
    `insert into kriya.edit_jobs (id, user_id, device_id, dispatch_id, project, brief)
     values ($1, $2, $3, $4, '0123456789abcdef', 'cut it')`,
    [id, user, deviceId, await dispatch(user, deviceId)]
  )
  return id
}

const reserve = (
  user: string,
  deviceId: string,
  jobId: string,
  bytes: number,
  kind = "preview"
) =>
  pg.query<{ id: string; storage_path: string }>(
    `select * from kriya.reserve_edit_preview($1, $2, $3, $4, $5, $6, null, 1000, 14)`,
    [user, deviceId, jobId, kind, bytes, randomUUID().replaceAll("-", "").padEnd(64, "a")]
  )

const setCap = (bytes: number) =>
  pg.query("update kriya.plans set editing_preview_bytes = $1", [bytes])

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
  aliceDevice = await device(alice)
  bobDevice = await device(bob)
  job = await newJob(alice, aliceDevice)
  await setCap(5000)
})

describe("ET-DB-01: each person sees only their own", () => {
  it("jobs and deliverables", async () => {
    await reserve(alice, aliceDevice, job, 10)
    const seen = (user: string, table: string) =>
      asUser(
        pg,
        user,
        async (tx) => (await tx.query(`select id from kriya.${table}`)).rows
      )
    expect(await seen(alice, "edit_jobs")).toHaveLength(1)
    expect(await seen(bob, "edit_jobs")).toHaveLength(0)
    expect(await seen(alice, "edit_deliverables")).toHaveLength(1)
    expect(await seen(bob, "edit_deliverables")).toHaveLength(0)
    await pg.query("delete from kriya.edit_deliverables")
  })

  it("questions and notes", async () => {
    await pg.query(
      `insert into kriya.edit_questions (user_id, device_id, job_id, kind, prompt, options, expires_at)
       values ($1, $2, $3, 'take', 'Which take?', '[]', now() + interval '1 hour')`,
      [alice, aliceDevice, job]
    )
    await asUser(pg, alice, (tx) =>
      tx.query(
        "insert into kriya.edit_notes (user_id, job_id, at_flicks, body) values ($1, $2, 0, 'Bigger')",
        [alice, job]
      )
    )
    for (const table of ["edit_questions", "edit_notes"]) {
      const rows = await asUser(
        pg,
        bob,
        async (tx) => (await tx.query(`select id from kriya.${table}`)).rows
      )
      expect(rows, table).toHaveLength(0)
    }
    // Bob can't pin a note to Alice's job, or answer her question
    await expect(
      asUser(pg, bob, (tx) =>
        tx.query(
          "insert into kriya.edit_notes (user_id, job_id, at_flicks, body) values ($1, $2, 0, 'x')",
          [bob, job]
        )
      )
    ).rejects.toThrow(/row-level security/)
    const answered = await asUser(pg, bob, (tx) =>
      tx.query(
        "update kriya.edit_questions set status = 'answered', answer = '1' returning id"
      )
    )
    expect(answered.rows).toHaveLength(0)
  })

  it("a job can't name someone else's computer, action, thread or parent", async () => {
    const attempt = (user: string, over: Record<string, unknown>) =>
      asUser(pg, user, (tx) =>
        tx.query(
          `insert into kriya.edit_jobs (user_id, device_id, dispatch_id, thread_id, revision_of, project, brief)
           values ($1, $2, $3, $4, $5, '0123456789abcdef', 'x')`,
          [user, over.device, over.dispatch, over.thread ?? null, over.parent ?? null]
        )
      )
    const mine = await dispatch(bob, bobDevice)
    await expect(attempt(bob, { device: aliceDevice, dispatch: mine })).rejects.toThrow(
      /row-level security/
    )
    await expect(
      attempt(bob, { device: bobDevice, dispatch: await dispatch(alice, aliceDevice) })
    ).rejects.toThrow(/row-level security/)
    await expect(
      attempt(bob, { device: bobDevice, dispatch: mine, parent: job })
    ).rejects.toThrow(/foreign key/)
    await expect(
      attempt(bob, { device: bobDevice, dispatch: mine, thread: "someone-elses" })
    ).rejects.toThrow(/row-level security/)
  })
})

describe("ET-DB-02: a device works only on its own job", () => {
  it("another device, even the same person's, is refused", async () => {
    await expect(reserve(bob, bobDevice, job, 10)).rejects.toThrow(/edit job not open/)
    const second = await device(alice)
    await expect(reserve(alice, second, job, 10)).rejects.toThrow(/edit job not open/)
  })

  it("a device can't reach the function directly as a session", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          `select kriya.reserve_edit_preview($1, $2, $3, 'preview', 1, repeat('a', 64), null, 100, 1)`,
          [alice, aliceDevice, job]
        )
      )
    ).rejects.toThrow(/permission denied/)
  })
})

describe("ET-DB-03: a session can't set a job's status", () => {
  it("by update, by insert, or on a deliverable", async () => {
    const update = (sql: string) => asUser(pg, alice, (tx) => tx.query(sql))
    for (const sql of [
      "update kriya.edit_jobs set status = 'delivered'",
      "update kriya.edit_jobs set verdict = '{}'",
      "update kriya.edit_deliverables set status = 'ready'",
    ])
      await expect(update(sql), sql).rejects.toThrow(/permission denied/)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          `insert into kriya.edit_jobs (user_id, device_id, dispatch_id, project, brief, status)
           values ($1, $2, $3, '0123456789abcdef', 'x', 'delivered')`,
          [alice, aliceDevice, randomUUID()]
        )
      )
    ).rejects.toThrow(/permission denied/)
    // "Looks good" is theirs
    await update("update kriya.edit_jobs set accepted_at = now()")
  })

  it("the database refuses a status jump, whoever asks", async () => {
    await expect(
      pg.query("update kriya.edit_jobs set status = 'delivered' where id = $1", [job])
    ).rejects.toThrow()
  })
})

describe("ET-DB-04: the preview limit", () => {
  it("holds across parallel calls, and cap 0 refuses", async () => {
    await setCap(100)
    const jobs = await Promise.all([1, 2, 3, 4, 5].map(() => newJob(alice, aliceDevice)))
    const results = await Promise.allSettled(
      jobs.map((j) => reserve(alice, aliceDevice, j, 30))
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3)
    const refused = results.flatMap((r) =>
      r.status === "rejected" ? [String(r.reason)] : []
    )
    expect(refused.every((text) => /cap reached/.test(text))).toBe(true)
    await pg.query("delete from kriya.edit_deliverables")

    await setCap(0)
    await expect(reserve(alice, aliceDevice, jobs[0], 1)).rejects.toThrow(/not in plan/)
    await setCap(5000)
  })

  it("refuses over the per-file limit; a second file of a kind unless it's the retry", async () => {
    await expect(reserve(alice, aliceDevice, job, 1001)).rejects.toThrow(/too large/)
    const sha = "b".repeat(64)
    const again = () =>
      pg.query<{ id: string }>(
        `select * from kriya.reserve_edit_preview($1, $2, $3, 'preview', 10, $4, null, 1000, 14)`,
        [alice, aliceDevice, job, sha]
      )
    const first = await again()
    expect((await again()).rows[0].id).toBe(first.rows[0].id)
    await expect(reserve(alice, aliceDevice, job, 11)).rejects.toThrow(/preview exists/)
    await pg.query("delete from kriya.edit_deliverables")
  })
})

describe("ET-DB-06: RLS, policies and a pinned search_path", () => {
  it("every new table", async () => {
    const tables = ["edit_jobs", "edit_deliverables", "edit_questions", "edit_notes"]
    for (const table of tables) {
      const { rows } = await pg.query<{ relrowsecurity: boolean }>(
        "select relrowsecurity from pg_class where oid = $1::regclass",
        [`kriya.${table}`]
      )
      expect(rows[0].relrowsecurity, table).toBe(true)
      const policies = await pg.query("select 1 from pg_policies where tablename = $1", [
        table,
      ])
      expect(policies.rows.length, table).toBeGreaterThan(0)
    }
    const { rows } = await pg.query<{ proconfig: string[] }>(
      "select proconfig from pg_proc where proname = 'reserve_edit_preview'"
    )
    expect(rows[0].proconfig.join()).toMatch(/search_path=/)
  })
})
