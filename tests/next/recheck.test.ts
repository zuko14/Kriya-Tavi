import fs from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { deriveEpisode } from "@/lib/agent/episodes"
import { calendarCreate, saveConnection } from "@/lib/connectors"
import { githubCreateIssue } from "@/lib/connectors/github"
import { sheetsAppend } from "@/lib/connectors/sheets"
import { recheckDeliveries, type Readers } from "@/lib/delivery/recheck"
import { recheckBy, recheckTarget } from "@/lib/delivery/rules"
import { deliveryOf } from "@/lib/delivery/status"
import { deliveryForTasks, recheckDue } from "@/queries/episodes"

import { createUser, type TestDb } from "../db/harness"
import { connectedUser, REPO, serve, TOKEN } from "../connectors/fixtures"

vi.mock("server-only", () => ({}))

// N3 (ND-04): the late re-check. The connectors' read-back says "unverified"
// when it can't read and "failed" when it read and disagreed (NF-11, option
// B); the worker step then looks once more, 2–30 minutes later, with the
// run's own person's token, and records one delivery_checks row. Real
// connector code against faked HTTP; nothing leaves the machine.

const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab"
const EVENT = "evt12345abc"
const calendarUrl = (id = EVENT) =>
  new RegExp(`googleapis\\.com/calendar/v3/calendars/primary/events/${id}$`)
const event = (over: Record<string, unknown> = {}) => ({
  id: EVENT,
  status: "confirmed",
  summary: "Maths exam",
  start: { dateTime: "2026-10-30T10:00:00+05:30" },
  attendees: [],
  ...over,
})
const created = {
  id: EVENT,
  summary: "Maths exam",
  htmlLink: "https://calendar.example/e",
}
const calendarInput = {
  title: "Maths exam",
  start: "2026-10-30T10:00:00+05:30",
  end: "2026-10-30T11:00:00+05:30",
  timeZone: "Asia/Kolkata",
}
const unverified = (value: string) => ({
  status: "unverified",
  method: "api_readback",
  evidence: [{ kind: "provider_id", value }],
})

let pg: TestDb
let alice: string
let n = 0

const q = (sql: string, params: unknown[] = []) => pg.query(sql, params)

beforeEach(async () => {
  const world = await connectedUser(["google", "github"])
  pg = world.pg
  alice = world.userId
  n = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// A finished run of `user`'s, with the task around it
async function run(
  user: string,
  o: {
    tool?: string
    input?: unknown
    verification?: unknown
    undo?: unknown
    minutesAgo?: number
    sideEffect?: boolean
    status?: string
  } = {}
) {
  n++
  const agent = `a${user.slice(-6)}`
  await q(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g') on conflict do nothing",
    [agent, user]
  )
  const thread = `t${user.slice(-6)}`
  await q(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3) on conflict do nothing",
    [thread, user, agent]
  )
  const { rows } = await q(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
    [user, thread]
  )
  const task = (rows[0] as { id: string }).id
  const { rows: made } = await q(
    `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, status,
       input, verification, undo, undo_until, finished_at)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9::jsonb,
       case when $9::jsonb is null then null else now() + interval '10 minutes' end,
       now() - make_interval(mins => $10)) returning id`,
    [
      task,
      user,
      `c${n}`,
      o.tool ?? "calendar_create_event",
      o.sideEffect ?? true,
      o.status ?? "succeeded",
      JSON.stringify(o.input ?? calendarInput),
      o.verification === null
        ? null
        : JSON.stringify(o.verification ?? unverified(EVENT)),
      o.undo === undefined ? null : JSON.stringify(o.undo),
      o.minutesAgo ?? 10,
    ]
  )
  return { task, id: (made[0] as { id: string }).id }
}

const checks = async () =>
  (
    await q(
      "select execution_id, user_id, kind, status, evidence from kriya.delivery_checks order by checked_at, execution_id"
    )
  ).rows as {
    execution_id: string
    user_id: string
    kind: string
    status: string
    evidence: unknown
  }[]

// Readers that record what they were asked and answer from a script
function fakeReaders(answer: "verified" | "gone" | "throw" = "verified") {
  const asked: { kind: string; userId: string; ref: unknown }[] = []
  const readers: Readers = {
    async calendar(userId, eventId) {
      asked.push({ kind: "calendar", userId, ref: eventId })
      if (answer === "throw") throw new Error("provider down")
      return answer === "gone"
        ? { found: false }
        : {
            found: true,
            cancelled: false,
            title: "Maths exam",
            attendees: [],
            startMs: Date.parse(calendarInput.start),
          }
    },
    async githubIssue(userId, ref) {
      asked.push({ kind: "github", userId, ref })
      return { title: "Fix" }
    },
    async sheetsRange(userId, ref) {
      asked.push({ kind: "sheets", userId, ref })
      return [["a", "1"]]
    },
  }
  return { readers, asked }
}

describe("NF-11 option B: a read-back that can't read is unverified, one that disagrees is failed", () => {
  const input = { ...calendarInput }
  it("calendar", async () => {
    serve([
      { method: "POST", url: /\/events\?/, body: created },
      { url: calendarUrl(), status: 404, body: { error: { message: "Not Found" } } },
      { method: "POST", url: /\/events\?/, body: created },
      { url: calendarUrl(), body: event({ summary: "Other title" }) },
      { method: "POST", url: /\/events\?/, body: created },
      { url: calendarUrl(), body: event() },
    ])
    const a = await calendarCreate(alice, input)
    expect(a.verification.status).toBe("unverified")
    expect(a.verification.evidence).toEqual(
      expect.arrayContaining([{ kind: "provider_id", value: EVENT }])
    )
    expect((await calendarCreate(alice, input)).verification.status).toBe("failed")
    expect((await calendarCreate(alice, input)).verification.status).toBe("verified")
  })

  it("GitHub issue", async () => {
    const issue = {
      number: 5,
      title: "Fix",
      html_url: "https://github.com/x/y/issues/5",
      state: "open",
    }
    serve([
      { method: "POST", url: /\/issues$/, body: issue },
      { url: /\/issues\/5$/, status: 404, body: { message: "Not Found" } },
      { method: "POST", url: /\/issues$/, body: issue },
      { url: /\/issues\/5$/, body: { ...issue, title: "Renamed" } },
      { method: "POST", url: /\/issues$/, body: issue },
      { url: /\/issues\/5$/, body: issue },
    ])
    const make = () => githubCreateIssue(alice, { repo: REPO, title: "Fix" })
    expect((await make()).verification.status).toBe("unverified")
    expect((await make()).verification.status).toBe("failed")
    expect((await make()).verification.status).toBe("verified")
  })

  it("Sheets rows", async () => {
    const wrote = { updates: { updatedRange: "Sheet1!A5:B5", updatedRows: 1 } }
    serve([
      { method: "POST", url: /:append/, body: wrote },
      { url: /values\//, status: 404, body: { error: { message: "nope" } } },
      { method: "POST", url: /:append/, body: wrote },
      { url: /values\//, body: { values: [["different", 2]] } },
      { method: "POST", url: /:append/, body: wrote },
      { url: /values\//, body: { values: [["a", 1]] } },
    ])
    const add = () =>
      sheetsAppend(alice, { spreadsheetId: SHEET, range: "Sheet1", rows: [["a", 1]] })
    expect((await add()).verification.status).toBe("unverified")
    expect((await add()).verification.status).toBe("failed")
    expect((await add()).verification.status).toBe("verified")
  })

  it("an unreadable read-back reads as 'wasn't checked', a disagreeing one as 'failed'", () => {
    const episode = (status: string) =>
      deriveEpisode(
        [
          {
            id: "e1",
            toolName: "calendar_create_event",
            status: "succeeded",
            input: calendarInput,
            verification: { ...unverified(EVENT), status, note: "x" },
          },
        ],
        "",
        []
      ).unconfirmed[0].reason
    expect(episode("unverified")).toBe("Ran, but wasn't checked afterwards.")
    expect(episode("failed")).toBe("Ran, but the check afterwards failed.")
  })
})

describe("NT-RCK-01 which runs are looked at", () => {
  it("only side-effect, succeeded, unverified or missing, 2–30 minutes old, with an id and a reader", async () => {
    const eligible = [
      await run(alice, { minutesAgo: 10 }),
      // Missing verification, but the undo spec names the event
      await run(alice, {
        minutesAgo: 3,
        verification: null,
        undo: { kind: "calendar_event", eventId: "evtUndo123", notifies: false },
      }),
      await run(alice, { minutesAgo: 29 }),
    ]
    await run(alice, { verification: { ...unverified(EVENT), status: "verified" } })
    await run(alice, { verification: { ...unverified(EVENT), status: "failed" } })
    await run(alice, { minutesAgo: 1 })
    await run(alice, { minutesAgo: 31 })
    await run(alice, { sideEffect: false })
    await run(alice, { status: "failed" })
    await run(alice, { tool: "gmail_draft", input: { to: ["a@example.com"] } })
    await run(alice, { verification: { ...unverified(""), evidence: [] } })
    await run(alice, { minutesAgo: 10, input: { title: "" } })
    const { readers, asked } = fakeReaders()
    const result = await recheckDeliveries(new Date(), { readers })
    // Five pass the query; the rule turns two of them away (no id, no title)
    expect(result).toMatchObject({
      candidates: 5,
      checked: 3,
      skipped: 2,
      errors: 0,
      verified: 3,
    })
    expect(asked.map((a) => a.ref).sort()).toEqual([EVENT, EVENT, "evtUndo123"].sort())
    expect((await checks()).map((c) => c.execution_id).sort()).toEqual(
      eligible.map((e) => e.id).sort()
    )
  })

  it("recheckTarget: bad ids and unreadable inputs aren't targets", () => {
    const base = {
      toolName: "github_create_issue",
      verification: unverified("octo-org/kriya-demo#5"),
    }
    expect(recheckTarget({ ...base, input: { title: "Fix" } })).toMatchObject({
      kind: "github_issue",
      repo: "octo-org/kriya-demo",
      number: 5,
    })
    expect(
      recheckTarget({
        ...base,
        verification: unverified("../../etc#5"),
        input: { title: "Fix" },
      })
    ).toBeNull()
    expect(
      recheckTarget({
        ...base,
        verification: unverified("not an id"),
        input: { title: "Fix" },
      })
    ).toBeNull()
    expect(
      recheckTarget({
        toolName: "sheets_append",
        verification: unverified("Sheet1!A5"),
        input: { spreadsheetId: "short", rows: [["a"]] },
      })
    ).toBeNull()
    // A truncated input (redactInput) can't be compared
    expect(
      recheckTarget({
        toolName: "sheets_append",
        verification: unverified("Sheet1!A5"),
        input: { truncated: "[[" },
      })
    ).toBeNull()
    // The start is compared only when it names an offset
    expect(
      recheckTarget({
        toolName: "calendar_create_event",
        verification: null,
        undo: { kind: "calendar_event", eventId: EVENT },
        input: { title: "T", start: "2026-10-30T10:00:00" },
      })
    ).toMatchObject({ startMs: null })
  })

  it("recheckBy is 30 minutes after the run finished, and only while that is ahead", () => {
    const finished = new Date("2026-10-24T10:00:00Z")
    expect(recheckBy(finished, new Date("2026-10-24T10:05:00Z"))?.toISOString()).toBe(
      "2026-10-24T10:30:00.000Z"
    )
    expect(recheckBy(finished, new Date("2026-10-24T10:31:00Z"))).toBeNull()
    expect(recheckBy(null, finished)).toBeNull()
  })
})

describe("NT-RCK-02 one row per run, nothing else changes", () => {
  it("a second tick adds nothing; runs, episodes and receipts stay as they were", async () => {
    const r = await run(alice)
    const episode = deriveEpisode(
      [
        {
          id: r.id,
          toolName: "calendar_create_event",
          status: "succeeded",
          input: calendarInput,
          verification: unverified(EVENT),
        },
      ],
      "",
      []
    )
    await q(
      `insert into kriya.episodes (user_id, task_id, thread_id, done, unconfirmed, checks, seq, hash)
       values ($1, $2, $3, $4, $5, $6, 1, 'h1')`,
      [
        alice,
        r.task,
        `t${alice.slice(-6)}`,
        JSON.stringify(episode.done),
        JSON.stringify(episode.unconfirmed),
        "[]",
      ]
    )
    const snapshot = async () => ({
      runs: (await q("select * from kriya.tool_executions order by id")).rows,
      episodes: (await q("select * from kriya.episodes order by id")).rows,
    })
    const before = await snapshot()
    const { readers, asked } = fakeReaders()
    expect(await recheckDeliveries(new Date(), { readers })).toMatchObject({ checked: 1 })
    expect(await recheckDeliveries(new Date(), { readers })).toMatchObject({
      candidates: 0,
      checked: 0,
    })
    expect(asked).toHaveLength(1)
    expect(await checks()).toHaveLength(1)
    expect(await snapshot()).toEqual(before)
  })

  it("two workers racing for the same run leave one row", async () => {
    await run(alice)
    const { readers } = fakeReaders()
    const [a, b] = await Promise.all([
      recheckDeliveries(new Date(), { readers }),
      recheckDeliveries(new Date(), { readers }),
    ])
    expect(a.checked + b.checked).toBe(1)
    expect(await checks()).toHaveLength(1)
  })
})

describe("NT-RCK-03 the real readers: present, gone, unreadable", () => {
  it("calendar: there → verified; missing or cancelled → gone; provider error → unverified, once", async () => {
    const ids = ["evtThere111", "evtDeleted22", "evtCancelled3", "evtBroken444"]
    for (const id of ids) await run(alice, { verification: unverified(id) })
    const calls = serve([
      { url: calendarUrl(ids[0]), body: event({ id: ids[0] }) },
      { url: calendarUrl(ids[1]), status: 404, body: { error: {} } },
      { url: calendarUrl(ids[2]), body: event({ id: ids[2], status: "cancelled" }) },
      { url: calendarUrl(ids[3]), status: 500, body: { error: { message: "boom" } } },
    ])
    const result = await recheckDeliveries()
    expect(result).toMatchObject({
      checked: 4,
      verified: 1,
      gone: 2,
      unverified: 1,
      errors: 0,
    })
    const byId = Object.fromEntries(
      (await checks()).map((c) => [
        (c.evidence as { value: string }[])[0].value,
        c.status,
      ])
    )
    expect(byId).toEqual({
      evtThere111: "verified",
      evtDeleted22: "gone",
      evtCancelled3: "gone",
      evtBroken444: "unverified",
    })
    // Reads only, with the person's token; the failed read isn't tried again
    expect(calls.every((c) => c.method === "GET")).toBe(true)
    expect(
      calls.every((c) => c.headers.authorization === `Bearer ${TOKEN("google")}`)
    ).toBe(true)
    expect(await recheckDeliveries()).toMatchObject({ candidates: 0 })
    expect(calls).toHaveLength(4)
  })

  it("a different title or guest list is failed, never verified", async () => {
    await run(alice, { input: { ...calendarInput, attendees: ["a@example.com"] } })
    serve([
      {
        url: calendarUrl(),
        body: event({ attendees: [{ email: "someone@else.example" }] }),
      },
    ])
    expect(await recheckDeliveries()).toMatchObject({ failed: 1, verified: 0 })
    expect((await checks())[0].status).toBe("failed")
  })

  it("GitHub issue: there with the title → verified; a 404 stays unverified (it also means no access)", async () => {
    const issue = {
      number: 5,
      title: "Fix",
      state: "open",
      html_url: "https://github.com/x/y/issues/5",
    }
    await run(alice, {
      tool: "github_create_issue",
      input: { repo: REPO, title: "Fix" },
      verification: unverified(`${REPO}#5`),
    })
    await run(alice, {
      tool: "github_create_issue",
      input: { repo: REPO, title: "Gone" },
      verification: unverified(`${REPO}#6`),
    })
    serve([
      { url: /\/issues\/5$/, body: issue },
      { url: /\/issues\/5\/comments/, body: [] },
      { url: /\/issues\/6$/, status: 404, body: { message: "Not Found" } },
    ])
    expect(await recheckDeliveries()).toMatchObject({
      checked: 2,
      verified: 1,
      unverified: 1,
      gone: 0,
    })
  })

  it("Sheets: the range holds the cells → verified (text vs number is fine); spreadsheet 404 → gone", async () => {
    await run(alice, {
      tool: "sheets_append",
      input: {
        spreadsheetId: SHEET,
        range: "Sheet1",
        rows: [
          ["a", 1],
          ["b", 2.5],
        ],
      },
      verification: unverified("Sheet1!A5:B6"),
    })
    await run(alice, {
      tool: "sheets_update",
      input: { spreadsheetId: SHEET, range: "Sheet2!A1", rows: [["x"]] },
      verification: unverified("Sheet2!A1"),
    })
    serve([
      {
        url: /values\/Sheet1/,
        body: {
          values: [
            ["a", "1"],
            ["b", "2.5"],
          ],
        },
      },
      { url: /values\/Sheet2/, status: 404, body: { error: { message: "nope" } } },
    ])
    expect(await recheckDeliveries()).toMatchObject({ checked: 2, verified: 1, gone: 1 })
  })
})

describe("NT-RCK-04 each read is as the run's own person", () => {
  it("uses that person's token, even for an id that is someone else's", async () => {
    const bob = await createUser(pg)
    await saveConnection(bob, "google", {
      accessToken: "token-of-bob",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      account: "bob",
    })
    // Alice's run names an event that is Bob's; Bob's own run names his
    await run(alice, { verification: unverified("evtOfBob999") })
    await run(bob, { verification: unverified("evtBobOwn888") })
    const calls = serve([
      { url: calendarUrl("evtOfBob999"), status: 404, body: { error: {} } },
      { url: calendarUrl("evtBobOwn888"), body: event({ id: "evtBobOwn888" }) },
    ])
    await recheckDeliveries()
    const auth = Object.fromEntries(
      calls.map((c) => [c.url.split("/").pop(), c.headers.authorization])
    )
    expect(auth).toEqual({
      evtOfBob999: `Bearer ${TOKEN("google")}`,
      evtBobOwn888: "Bearer token-of-bob",
    })
    // Alice's forged id reads as not there for her; each row is its own person's
    const rows = await checks()
    expect(rows.find((c) => c.user_id === alice)?.status).toBe("gone")
    expect(rows.find((c) => c.user_id === bob)?.status).toBe("verified")
    expect(await deliveryForTasks(alice, [])).toEqual([])
  })
})

describe("NT-RCK-05 one bad row doesn't stop the step; the limit holds", () => {
  it("a reader that throws leaves that run unverified and the rest go on", async () => {
    await run(alice, { minutesAgo: 20 })
    await run(alice, { minutesAgo: 10, verification: unverified("evtSecond22") })
    let first = true
    const { readers } = fakeReaders()
    const flaky: Readers = {
      ...readers,
      async calendar(userId, id) {
        if (first) {
          first = false
          throw new Error("socket hang up")
        }
        return readers.calendar(userId, id)
      },
    }
    expect(await recheckDeliveries(new Date(), { readers: flaky })).toMatchObject({
      checked: 2,
      unverified: 1,
      verified: 1,
      errors: 0,
    })
  })

  it("at most `limit` runs a tick, oldest first", async () => {
    for (let i = 0; i < 5; i++)
      await run(alice, {
        minutesAgo: 25 - i,
        verification: unverified(`evtLimit${i}000`),
      })
    const { readers, asked } = fakeReaders()
    expect(await recheckDeliveries(new Date(), { readers, limit: 2 })).toMatchObject({
      checked: 2,
    })
    expect(asked.map((a) => a.ref)).toEqual(["evtLimit0000", "evtLimit1000"])
    expect(await recheckDeliveries(new Date(), { readers, limit: 2 })).toMatchObject({
      checked: 2,
    })
    expect(await recheckDeliveries(new Date(), { readers, limit: 2 })).toMatchObject({
      checked: 1,
    })
    expect(await checks()).toHaveLength(5)
  })
})

describe("NG-17 / NG-18 at unit level: the card's status after the re-check", () => {
  // The real calendarCreate whose read-back came back not found (NSC-17), then
  // its episode, then the later check
  async function scenario(later: "present" | "deleted") {
    serve([
      { method: "POST", url: /\/events\?/, body: created },
      { url: calendarUrl(), status: 404, body: { error: {} } },
    ])
    const made = await calendarCreate(alice, calendarInput)
    const r = await run(alice, { verification: made.verification })
    const episode = deriveEpisode(
      [
        {
          id: r.id,
          toolName: "calendar_create_event",
          status: "succeeded",
          input: calendarInput,
          verification: made.verification,
        },
      ],
      "",
      []
    )
    const view = () =>
      deliveryForTasks(alice, [r.task]).then((rows) => deliveryOf(episode, rows))
    expect((await view()).status).toBe("not_confirmed")
    serve([
      later === "present"
        ? { url: calendarUrl(), body: event() }
        : { url: calendarUrl(), status: 404, body: { error: {} } },
    ])
    await recheckDeliveries()
    return { view, due: r }
  }

  it("NG-17: not found at first, there later → delivered", async () => {
    const { view } = await scenario("present")
    expect(await view()).toMatchObject({
      status: "delivered",
      laterVerified: [expect.any(String)],
    })
  })

  it("NG-18: deleted before the re-check → gone, never delivered", async () => {
    const { view } = await scenario("deleted")
    expect(await view()).toMatchObject({
      status: "not_confirmed",
      gone: [expect.any(String)],
      laterVerified: [],
    })
  })

  it("the card's 'will check again by' line: waiting runs only, until checked", async () => {
    const r = await run(alice, { minutesAgo: 5 })
    const now = new Date()
    const waiting = await recheckDue(alice, [r.id], now)
    expect(waiting).toHaveLength(1)
    expect(new Date(waiting[0].by).getTime()).toBeGreaterThan(now.getTime() + 24 * 60_000)
    expect(new Date(waiting[0].by).getTime()).toBeLessThanOrEqual(
      now.getTime() + 25 * 60_000
    )
    // Past the window, or already checked, or someone else's: no line
    expect(
      await recheckDue(alice, [r.id], new Date(now.getTime() + 40 * 60_000))
    ).toEqual([])
    const bob = await createUser(pg)
    expect(await recheckDue(bob, [r.id], now)).toEqual([])
    serve([{ url: calendarUrl(), body: event() }])
    await q(
      "update kriya.tool_executions set finished_at = now() - interval '10 minutes'"
    )
    await recheckDeliveries()
    expect(await recheckDue(alice, [r.id], now)).toEqual([])
  })
})

describe("the worker step is behind next.recheck", () => {
  it("runs only with next.recheck, next.delivery and agents.inbox on, in its own try", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "worker", "index.ts"), "utf8")
    const at = source.indexOf("recheckDeliveries()")
    expect(at).toBeGreaterThan(0)
    const block = source.slice(
      source.lastIndexOf("try {", at),
      source.indexOf("} catch", at)
    )
    for (const key of ["next.recheck", "next.delivery", "agents.inbox"])
      expect(block).toContain(`getSetting("${key}")`)
  })
})
