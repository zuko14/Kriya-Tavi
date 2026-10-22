import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// actions/mandates.ts (O3): the person's decisions on a job. Identity from
// the session only (stubbed), PGlite underneath. OT-MND-03: approving
// creates goal, grants and schedules in one transaction. OT-MND-04: what
// approval refuses. OT-MND-05: revoke, close and Stop all.

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: state.user, email: null }),
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

import {
  approveMandate,
  closeMandate,
  confirmCriterion,
  declineMandate,
  pauseMandate,
  resumeMandate,
  revokeGrant,
  revokeMandate,
  stopAllMandates,
} from "@/actions/mandates"
import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { proposeMandate } from "@/lib/operator/mandates"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

let pg: TestDb
let alice: string
let bob: string

const SWITCHES = {
  KRIYA_OPERATOR_MANDATES: "on",
  KRIYA_AGENTS_GOALS: "on",
  KRIYA_AGENTS_INBOX: "on",
}
const setEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

let task = 0
const propose = async (user = alice, extra: Record<string, unknown> = {}) => {
  const result = await proposeMandate(
    {
      userId: user,
      threadId: user === alice ? "t1" : "tb",
      agentId: user === alice ? "a1" : "b1",
      taskId: `00000000-0000-4000-8000-${String(++task).padStart(12, "0")}`,
    },
    {
      title: `Collect ${task}`,
      objective: "Remind each client and chase until paid.",
      criteria: [
        {
          text: "Drafts saved",
          evidence: { kind: "tool_verified", tool: "gmail_draft" },
        },
        { text: "Client agreed", evidence: { kind: "person_confirmed" } },
      ],
      grants: [
        {
          tool: "gmail_draft",
          pins: { to: ["a@example.com"] },
          maxUses: 6,
          why: "Drafts",
        },
        {
          tool: "sheets_append",
          pins: { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvW", range: "Log!A1" },
          maxUses: 3,
          why: "Log",
        },
      ],
      dueInDays: 10,
      ...extra,
    }
  )
  if (!("mandateId" in result)) throw new Error(JSON.stringify(result))
  return result.mandateId
}

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await pg.query<T>(query, params)).rows
const mandate = async (id: string) =>
  (
    await rows<Record<string, unknown>>("select * from kriya.mandates where id = $1", [
      id,
    ])
  )[0]
const count = async (table: string) =>
  (await rows<{ n: number }>(`select count(*)::int as n from kriya.${table}`))[0].n

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  setEnv({ ...SWITCHES, KRIYA_OPERATOR_MAX_ACTIVE: undefined })
  alice = await createUser(pg)
  bob = await createUser(pg)
  state.user = alice
  // Room for a few jobs' goals and schedules on the test plan
  await pg.query("update kriya.plans set max_goals = 10, max_schedules = 20")
  for (const [user, agent, thread] of [
    [alice, "a1", "t1"],
    [bob, "b1", "tb"],
  ]) {
    await asUser(pg, user, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Lekha', 'r', 'g')",
        [agent, user]
      )
      await tx.query(
        "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
        [thread, user, agent]
      )
    })
  }
})

afterEach(() => setEnv({ ...SWITCHES, KRIYA_OPERATOR_MAX_ACTIVE: undefined }))

describe("approving a job (OT-MND-03)", () => {
  it("creates its goal, the grants as edited, and kickoff + check-in schedules", async () => {
    const id = await propose(alice, {
      budgetInr: 200,
      checkIn: { freq: "daily", at: "09:30" },
    })
    const before = Date.now()
    const result = await approveMandate(id, { drop: [1], maxUses: { 0: 4 } })
    if (!("goalId" in result)) throw new Error(JSON.stringify(result))

    const job = await mandate(id)
    expect(job).toMatchObject({ status: "active", goal_id: result.goalId })
    expect(job.approved_at).not.toBeNull()
    const [goal] = await rows<Record<string, unknown>>("select * from kriya.goals")
    expect(goal).toMatchObject({
      id: result.goalId,
      agent_id: "a1",
      status: "active",
      monthly_budget_micro_inr: 200000000,
    })
    expect((goal.plan as { text: string }[]).map((item) => item.text)).toEqual([
      "Drafts saved",
      "Client agreed",
    ])

    // The sheet grant was dropped; the draft grant lowered to 4, expiring with the job
    const grants = await rows<Record<string, unknown>>("select * from kriya.grants")
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      tool: "gmail_draft",
      max_uses: 4,
      uses: 0,
      status: "active",
      pins: { to: ["a@example.com"] },
    })
    expect(String(grants[0].expires_at)).toBe(String(job.due_at))

    const schedules = await rows<Record<string, unknown>>(
      "select * from kriya.schedules order by kind"
    )
    expect(schedules.map((s) => [s.kind, s.thread_id, s.goal_id, s.agent_id])).toEqual([
      ["once", goal.thread_id, goal.id, "a1"],
      ["recurring", goal.thread_id, goal.id, "a1"],
    ])
    const kickoff = new Date(schedules[0].next_run_at as string).getTime()
    expect(kickoff).toBeGreaterThanOrEqual(before + 55_000)
    expect(kickoff).toBeLessThan(Date.now() + 65_000)
    expect(schedules[1].rule).toEqual({ freq: "daily", at: "09:30" })
    expect(schedules.map((s) => s.cap_micro_inr)).toEqual([200000000, 200000000])
  })

  it("defaults the check-in to daily at 10:00", async () => {
    await approveMandate(await propose())
    const [checkIn] = await rows<{ rule: unknown }>(
      "select rule from kriya.schedules where kind = 'recurring'"
    )
    expect(checkIn.rule).toEqual({ freq: "daily", at: "10:00" })
  })

  it("leaves nothing behind when a step fails part-way", async () => {
    const id = await propose()
    // A check-in rule that can't run any more fails after goal and grants exist
    await pg.query(
      `update kriya.mandates set check_in = '{"freq":"once","startAt":"2020-01-01T00:00:00Z"}' where id = $1`,
      [id]
    )
    const result = await approveMandate(id)
    expect(result).toHaveProperty("error")
    expect((await mandate(id)).status).toBe("proposed")
    for (const table of ["goals", "grants", "schedules"])
      expect(await count(table), table).toBe(0)
    // Only the two original chats
    expect(await count("threads")).toBe(2)
  })
})

describe("what approval refuses (OT-MND-04)", () => {
  it("raising a grant's limit, or an unknown grant", async () => {
    const id = await propose()
    expect(await approveMandate(id, { maxUses: { 0: 7 } })).toHaveProperty("error")
    expect(await approveMandate(id, { drop: [5] })).toHaveProperty("error")
    expect((await mandate(id)).status).toBe("proposed")
  })

  it("a 4th open job with the default limit of 3", async () => {
    for (let i = 0; i < 3; i++)
      expect(await approveMandate(await propose())).toHaveProperty("goalId")
    const fourth = await propose()
    expect(await approveMandate(fourth)).toMatchObject({
      error: expect.stringMatching(/3/),
    })
    setEnv({ KRIYA_OPERATOR_MAX_ACTIVE: "4" })
    expect(await approveMandate(fourth)).toHaveProperty("goalId")
  })

  it("a job that isn't a proposal any more", async () => {
    const id = await propose()
    expect(await approveMandate(id)).toHaveProperty("goalId")
    expect(await approveMandate(id)).toHaveProperty("error")
    const declined = await propose()
    expect(await declineMandate(declined)).toEqual({ ok: true })
    expect(await approveMandate(declined)).toHaveProperty("error")
    expect(await count("goals")).toBe(1)
  })

  it("another person's job, which simply isn't found", async () => {
    const theirs = await propose(bob)
    expect(await approveMandate(theirs)).toHaveProperty("error")
    expect((await mandate(theirs)).status).toBe("proposed")
  })

  it("while operator.mandates, agents.goals or agents.inbox is off", async () => {
    const id = await propose()
    for (const key of Object.keys(SWITCHES)) {
      setEnv({ ...SWITCHES, [key]: "off" })
      expect(await approveMandate(id), key).toHaveProperty("error")
    }
    expect((await mandate(id)).status).toBe("proposed")
  })
})

describe("revoke, close and Stop all (OT-MND-05)", () => {
  const ended = async (id: string, status: string) => {
    const job = await mandate(id)
    expect(job.status).toBe(status)
    expect(job.closed_at).not.toBeNull()
    expect(
      await rows(
        "select status from kriya.grants where mandate_id = $1 and status <> 'revoked'",
        [id]
      )
    ).toEqual([])
    expect(
      await rows(
        "select status from kriya.schedules where goal_id = $1 and status <> 'ended'",
        [job.goal_id]
      )
    ).toEqual([])
    const [goal] = await rows<{ status: string }>(
      "select status from kriya.goals where id = $1",
      [job.goal_id]
    )
    expect(goal.status).toBe("abandoned")
  }

  it("revoking ends grants, schedules and the goal", async () => {
    const id = await propose()
    await approveMandate(id)
    expect(await revokeMandate(id)).toEqual({ ok: true })
    await ended(id, "revoked")
  })

  it("closing early does the same and says closed", async () => {
    const id = await propose()
    await approveMandate(id)
    expect(await closeMandate(id)).toEqual({ ok: true })
    await ended(id, "closed")
  })

  it("Stop all revokes every open job, paused and stuck ones too, and is audited", async () => {
    setEnv({ KRIYA_OPERATOR_MAX_ACTIVE: "5" })
    const ids = [await propose(), await propose(), await propose()]
    for (const id of ids) await approveMandate(id)
    await pauseMandate(ids[1])
    // Only Kriya marks a job stuck
    await pg.query("update kriya.mandates set status = 'needs_person' where id = $1", [
      ids[2],
    ])
    const proposal = await propose()
    state.user = bob
    const theirs = await propose(bob)
    await approveMandate(theirs)
    state.user = alice

    expect(await stopAllMandates()).toEqual({ ok: true, stopped: 3 })
    for (const id of ids) await ended(id, "revoked")
    // A proposal granted nothing and stays for the person to decide; Bob's job is untouched
    expect((await mandate(proposal)).status).toBe("proposed")
    expect((await mandate(theirs)).status).toBe("active")
    const audit = await rows<Record<string, unknown>>(
      "select actor_id, action, details from kriya.audit_events where action = 'mandates.stop_all'"
    )
    expect(audit).toEqual([
      { actor_id: alice, action: "mandates.stop_all", details: { stopped: 3 } },
    ])
  })
})

describe("the person's other controls", () => {
  it("pause pauses the goal's schedules; resume brings the check-in back", async () => {
    const id = await propose()
    await approveMandate(id)
    expect(await pauseMandate(id)).toEqual({ ok: true })
    expect((await mandate(id)).status).toBe("paused")
    expect(
      await rows("select status from kriya.schedules where status = 'active'")
    ).toEqual([])
    expect(await resumeMandate(id)).toEqual({ ok: true })
    expect((await mandate(id)).status).toBe("active")
    const active = await rows<{ kind: string }>(
      "select kind from kriya.schedules where status = 'active' order by kind"
    )
    expect(active.map((s) => s.kind)).toContain("recurring")
  })

  it("revoking one grant leaves the job and the other grants", async () => {
    const id = await propose()
    await approveMandate(id)
    const [grant] = await rows<{ id: string }>(
      "select id from kriya.grants where tool = 'gmail_draft'"
    )
    expect(await revokeGrant(grant.id)).toEqual({ ok: true })
    expect(await revokeGrant(grant.id)).toHaveProperty("error")
    const statuses = await rows<{ tool: string; status: string }>(
      "select tool, status from kriya.grants order by tool"
    )
    expect(statuses).toEqual([
      { tool: "gmail_draft", status: "revoked" },
      { tool: "sheets_append", status: "active" },
    ])
    expect((await mandate(id)).status).toBe("active")
  })

  it("ticks only person_confirmed criteria, once", async () => {
    const id = await propose()
    await approveMandate(id)
    expect(await confirmCriterion(id, "c1")).toHaveProperty("error")
    expect(await confirmCriterion(id, "c2")).toEqual({ ok: true })
    expect(await confirmCriterion(id, "c2")).toEqual({ ok: true })
    expect((await mandate(id)).confirmed).toEqual(["c2"])
  })

  it("refuses a proposal tick or a revoke from the wrong status", async () => {
    const id = await propose()
    expect(await confirmCriterion(id, "c2")).toHaveProperty("error")
    expect(await revokeMandate(id)).toHaveProperty("error")
    expect((await mandate(id)).status).toBe("proposed")
  })
})
