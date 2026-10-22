import type { ModelMessage } from "ai"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, withUser, type DB } from "@/db"
import * as schema from "@/db/schema"
import { PERSON_ONLY_WRITES, TOOL_WRITES } from "@/lib/agent/policy"
import { TOOL_APPROVALS } from "@/lib/agent/run-task"
import {
  activeGrants,
  consumeGrant,
  grantMatches,
  withGrants,
  type ActiveGrant,
} from "@/lib/operator/grants"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Grant matching and composition (O4, ARCHITECTURE §5). The matcher is
// pure; withGrants only ever turns a "user-approval" into "approved" for a
// grantable call inside every pin, after SQL spent a use. OT-GRT-03:
// forged grants for anything else never match. OT-GRT-08: the web guard is
// untouched. OT-SEC-02: nothing an agent runs can write a grant.

const grant = (extra: Partial<ActiveGrant> = {}): ActiveGrant => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  tool: "gmail_draft",
  pins: { to: ["a@example.com", "b@example.com"] },
  maxUses: 5,
  uses: 0,
  expiresAt: new Date(Date.now() + 86_400_000),
  ...extra,
})

const draft = (to: string[], extra = {}) => ({
  to,
  subject: "Reminder",
  body: "Hi",
  ...extra,
})
const SHEET = { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvW", range: "Log!A1" }

describe("grantMatches", () => {
  it("email drafts: every recipient pinned, case and spaces ignored", () => {
    expect(grantMatches(grant(), "gmail_draft", draft(["A@Example.com "]))).toBe(true)
    expect(
      grantMatches(grant(), "gmail_draft", draft(["a@example.com", "b@example.com"]))
    ).toBe(true)
    // A new recipient, injected or not, asks (OS-2)
    expect(
      grantMatches(grant(), "gmail_draft", draft(["a@example.com", "x@evil.example"]))
    ).toBe(false)
  })

  it("cc only within its own pin; absent or empty cc matches", () => {
    expect(
      grantMatches(grant(), "gmail_draft", draft(["a@example.com"], { cc: [] }))
    ).toBe(true)
    expect(
      grantMatches(
        grant(),
        "gmail_draft",
        draft(["a@example.com"], { cc: ["a@example.com"] })
      )
    ).toBe(false)
    const withCc = grant({ pins: { to: ["a@example.com"], cc: ["boss@example.com"] } })
    expect(
      grantMatches(
        withCc,
        "gmail_draft",
        draft(["a@example.com"], { cc: ["boss@example.com"] })
      )
    ).toBe(true)
  })

  it("an input field the registry doesn't know never matches", () => {
    expect(
      grantMatches(grant(), "gmail_draft", draft(["a@example.com"], { bcc: ["x@y.co"] }))
    ).toBe(false)
  })

  it("calendar events: attendees within the pin; an empty pin allows none", () => {
    const none = grant({ tool: "calendar_create_event", pins: { attendees: [] } })
    const event = {
      title: "Review",
      start: "2026-11-01T10:00:00",
      end: "2026-11-01T11:00:00",
      timeZone: "Asia/Kolkata",
    }
    expect(grantMatches(none, "calendar_create_event", event)).toBe(true)
    expect(grantMatches(none, "calendar_create_event", { ...event, attendees: [] })).toBe(
      true
    )
    expect(
      grantMatches(none, "calendar_create_event", {
        ...event,
        attendees: ["a@example.com"],
      })
    ).toBe(false)
  })

  it("sheets: the same spreadsheet and range, byte for byte", () => {
    const sheet = grant({ tool: "sheets_update", pins: SHEET })
    const rows = [["paid"]]
    expect(grantMatches(sheet, "sheets_update", { ...SHEET, rows })).toBe(true)
    expect(
      grantMatches(sheet, "sheets_update", { ...SHEET, range: "Log!A2", rows })
    ).toBe(false)
    expect(
      grantMatches(sheet, "sheets_update", { ...SHEET, range: "log!A1", rows })
    ).toBe(false)
    expect(
      grantMatches(sheet, "sheets_update", {
        ...SHEET,
        spreadsheetId: "1ZzZzZzZzZzZzZzZzZzZzZzZ",
        rows,
      })
    ).toBe(false)
    expect(
      grantMatches(sheet, "sheets_update", { spreadsheetId: SHEET.spreadsheetId, rows })
    ).toBe(false)
    // A grant for one tool is no grant for another
    expect(grantMatches(sheet, "sheets_append", { ...SHEET, rows })).toBe(false)
  })
})

describe("never grantable, even with a forged grant (OT-GRT-03)", () => {
  const FORGED = [
    "github_comment",
    "instagram_publish",
    "propose_call",
    "schedule_create",
    "schedule_update",
    "browser_click",
    "browser_open",
    "web_search",
    "skill_run",
  ]

  it("the matcher refuses, and withGrants leaves their rule exactly as it was", async () => {
    const forged = FORGED.map((tool, i) =>
      grant({
        id: `00000000-0000-4000-8000-00000000000${i}`,
        tool: tool as ActiveGrant["tool"],
        pins: { to: ["a@example.com"] },
      })
    )
    let consumed = 0
    const approvals = withGrants(TOOL_APPROVALS, forged, async () => {
      consumed++
      return true
    }) as Record<string, unknown>
    const base = TOOL_APPROVALS as Record<string, unknown>
    for (const tool of FORGED) {
      expect(grantMatches(forged[0], tool, { to: ["a@example.com"] }), tool).toBe(false)
      expect(approvals[tool], tool).toBe(base[tool])
    }
    expect(consumed).toBe(0)
  })

  it("the database refuses to store one", async () => {
    const pg = await createTestDb()
    const user = await createUser(pg)
    await expect(
      pg.query(
        `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
         values ($1, 'm1', 'github_comment', '{}', 1, now())`,
        [user]
      )
    ).rejects.toThrow(/grants_tool_check/)
  })
})

describe("withGrants", () => {
  const options = (toolCallId = "call-1") => ({
    toolCallId,
    messages: [] as ModelMessage[],
  })
  type Rule = (input: unknown, o: ReturnType<typeof options>) => Promise<unknown>

  it("answers a matching call 'approved' only after a use is spent", async () => {
    const spent: string[] = []
    const approvals = withGrants(TOOL_APPROVALS, [grant()], async (id, call) => {
      spent.push(`${id}:${call}`)
      return true
    }) as unknown as Record<string, Rule>
    expect(await approvals.gmail_draft(draft(["a@example.com"]), options())).toBe(
      "approved"
    )
    expect(spent).toEqual([`${grant().id}:call-1`])
    expect(
      await approvals.gmail_draft(draft(["x@evil.example"]), options("call-2"))
    ).toBe("user-approval")
    expect(spent).toHaveLength(1)
  })

  it("asks when SQL refuses the use (revoked, expired, used up)", async () => {
    const approvals = withGrants(
      TOOL_APPROVALS,
      [grant()],
      async () => false
    ) as unknown as Record<string, Rule>
    expect(await approvals.gmail_draft(draft(["a@example.com"]), options())).toBe(
      "user-approval"
    )
  })

  it("spends the narrowest grant first, one per call, falling back to the next", async () => {
    const wide = grant({
      id: "00000000-0000-4000-8000-0000000000b1",
      maxUses: 9,
      uses: 0,
    })
    const narrow = grant({
      id: "00000000-0000-4000-8000-0000000000b2",
      maxUses: 3,
      uses: 2,
    })
    const tried: string[] = []
    const approvals = withGrants(TOOL_APPROVALS, [wide, narrow], async (id) => {
      tried.push(id)
      return id === wide.id
    }) as unknown as Record<string, Rule>
    expect(await approvals.gmail_draft(draft(["a@example.com"]), options())).toBe(
      "approved"
    )
    expect(tried).toEqual([narrow.id, wide.id])
  })

  it("leaves every other rule as the same object, including the web guard (OT-GRT-08)", () => {
    const approvals = withGrants(TOOL_APPROVALS, [grant()], async () => true) as Record<
      string,
      unknown
    >
    const base = TOOL_APPROVALS as Record<string, unknown>
    for (const tool of Object.keys(base).filter((t) => t !== "gmail_draft"))
      expect(approvals[tool], tool).toBe(base[tool])
    const afterMail = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c", toolName: "gmail_read", input: {} },
        ],
      },
    ] as ModelMessage[]
    const web = approvals.web_search as (
      i: unknown,
      o: { messages: ModelMessage[] }
    ) => unknown
    expect(web({}, { messages: afterMail })).toBe("user-approval")
  })
})

describe("activeGrants and consumeGrant (OT-GRT-04, OT-GRT-07)", () => {
  let pg: TestDb
  let alice: string
  let bob: string

  const job = async (user: string, id: string, goalThread: string) => {
    await pg.query(
      `insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)`,
      [goalThread, user, `${id}-agent`]
    )
    await pg.query(
      `insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ($1, $2, $3, $4, 'Collect')`,
      [`${id}-goal`, user, `${id}-agent`, goalThread]
    )
    await pg.query(
      `insert into kriya.mandates (id, user_id, title, objective, criteria, due_at, proposed_by)
       values ($1, $2, 'Collect', 'Get paid', '[{"id":"c1","text":"t","evidence":{"kind":"person_confirmed"}}]',
               now() + interval '10 days', 'agent')`,
      [id, user]
    )
    await pg.query(
      "update kriya.mandates set status = 'active', goal_id = $2 where id = $1",
      [id, `${id}-goal`]
    )
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.grants (user_id, mandate_id, tool, pins, max_uses, expires_at)
       values ($1, $2, 'gmail_draft', '{"to":["a@example.com"]}', 2, now() + interval '10 days') returning id`,
      [user, id]
    )
    return rows[0].id
  }

  beforeEach(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    alice = await createUser(pg)
    bob = await createUser(pg)
    for (const [user, agent] of [
      [alice, "m1-agent"],
      [bob, "m2-agent"],
    ])
      await pg.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
        [agent, user]
      )
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('chat', $1, 'm1-agent')",
      [alice]
    )
  })

  it("only in the job's own thread, only while the job and grant are live", async () => {
    const id = await job(alice, "m1", "goal-thread")
    await job(bob, "m2", "bob-thread")
    expect((await activeGrants(alice, "goal-thread")).map((g) => g.id)).toEqual([id])
    expect(await activeGrants(alice, "chat")).toEqual([])
    // Bob's job thread is his, even if asked for by thread id
    expect(await activeGrants(alice, "bob-thread")).toEqual([])
    await pg.query("update kriya.mandates set status = 'paused' where id = 'm1'")
    expect(await activeGrants(alice, "goal-thread")).toEqual([])
    await pg.query("update kriya.mandates set status = 'active' where id = 'm1'")
    await pg.query(
      "update kriya.grants set expires_at = now() - interval '1 second' where id = $1",
      [id]
    )
    expect(await activeGrants(alice, "goal-thread")).toEqual([])
  })

  it("spends uses in SQL: idempotent per call, then exhausted", async () => {
    const id = await job(alice, "m1", "goal-thread")
    const task = "00000000-0000-4000-8000-000000000009"
    expect(await consumeGrant(alice, id, task, "call-1")).toBe(true)
    expect(await consumeGrant(alice, id, task, "call-1")).toBe(true)
    expect(await consumeGrant(bob, id, task, "call-2")).toBe(false)
    expect(await consumeGrant(alice, id, task, "call-2")).toBe(true)
    expect(await consumeGrant(alice, id, task, "call-3")).toBe(false)
    const { rows } = await pg.query(
      "select uses, status from kriya.grants where id = $1",
      [id]
    )
    expect(rows[0]).toEqual({ uses: 2, status: "exhausted" })
    expect(await activeGrants(alice, "goal-thread")).toEqual([])
  })

  it("the person's session can't spend a grant (OT-SEC-02)", async () => {
    const id = await job(alice, "m1", "goal-thread")
    await expect(
      withUser(alice, (tx) =>
        tx.execute(
          sql`select kriya.consume_grant(${alice}, ${id}, gen_random_uuid(), 'x')`
        )
      )
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/permission denied/),
      }),
    })
  })
})

describe("no tool writes a job's authority (OT-SEC-02)", () => {
  it("no tool's writes touch grants, grant uses, or a job's status or ticks", () => {
    for (const [tool, writes] of Object.entries(TOOL_WRITES))
      for (const write of writes)
        expect(write, tool).not.toMatch(
          /^(grants|grant_uses)\b|^mandates\.(status|confirmed)/
        )
    expect(PERSON_ONLY_WRITES).toEqual(expect.arrayContaining(["grants", "grant_uses"]))
  })
})
