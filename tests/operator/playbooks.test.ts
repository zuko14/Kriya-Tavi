import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Playbooks (O7, PLAYBOOKS.md, OD-09). OT-PB-01: every playbook fills into a
// proposal Kriya accepts: grantable tools pinned from the person's slots,
// known evidence kinds, check-ins at most daily, due within 30 days, work
// prompt within the schedule limit. OT-PB-02: the picker hides playbooks
// whose needs aren't met. OT-PB-03: a playbook job's runs carry the
// playbook as workflowId (quotes, K2). Plus the person's proposal action and
// the ledger upkeep OP-BOOKS relies on.

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: state.user, email: null }),
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))

import { proposeFromPlaybook } from "@/actions/mandates"
import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { CAPABILITIES, GRANTABLE } from "@/lib/agent/capabilities"
import { reviewMandates } from "@/lib/operator/loop"
import { proposalSchema, proposeMandate } from "@/lib/operator/mandates"
import { PIN_SCHEMAS } from "@/lib/operator/pins"
import {
  fillPlaybook,
  PLAYBOOKS,
  runnable,
  type Need,
  type Slots,
} from "@/lib/operator/playbooks"
import { claimDueSchedules, minGapMinutes, runDue } from "@/lib/schedules"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

const INVOICE = "00000000-0000-4000-8000-0000000000c1"
// The longest slot values the form accepts
const LONGEST: Slots = {
  invoices: Array.from(
    { length: 10 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
  ),
  emails: Array.from(
    { length: 10 },
    (_, i) => `client${i}-${"x".repeat(40)}@example.com`
  ),
  sheet: {
    spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvW",
    range: `Prices!A1:${"Z".repeat(20)}`,
  },
  text: "y".repeat(1000),
  date: "2026-10",
}

describe("every playbook fills into a valid proposal (OT-PB-01)", () => {
  it("has five playbooks with unique OP ids and versions", () => {
    expect(PLAYBOOKS.map((p) => p.id).sort()).toEqual([
      "OP-BOOKS",
      "OP-COLLECT",
      "OP-COMPARE",
      "OP-COMPLY",
      "OP-MEET",
    ])
    for (const p of PLAYBOOKS) expect(p.version).toBeGreaterThan(0)
  })

  for (const playbook of PLAYBOOKS) {
    it(`${playbook.id}: schema, grants, evidence, check-in, due, prompt length`, () => {
      const proposal = fillPlaybook(playbook, LONGEST)
      if ("error" in proposal) throw new Error(proposal.error)
      const parsed = proposalSchema.safeParse(proposal)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      expect(proposal.playbookId).toBe(playbook.id)
      expect(proposal.objective.length).toBeLessThanOrEqual(2000)
      expect(proposal.dueInDays).toBeLessThanOrEqual(30)
      expect(proposal.checkIn.freq).not.toBe("once")
      expect(minGapMinutes(proposal.checkIn)).toBeGreaterThanOrEqual(1440)
      for (const grant of proposal.grants) {
        expect(GRANTABLE.has(grant.tool), grant.tool).toBe(true)
        expect(
          PIN_SCHEMAS[grant.tool as keyof typeof PIN_SCHEMAS].safeParse(grant.pins)
            .success
        ).toBe(true)
        expect(grant.maxUses).toBeLessThanOrEqual(50)
      }
      for (const { evidence } of proposal.criteria) {
        if (evidence.kind !== "tool_verified") continue
        const capability = CAPABILITIES[evidence.tool]
        expect(capability?.verification, evidence.tool).not.toBe("none")
      }
    })
  }

  it("pins come from the person's slots, never anything else", () => {
    const collect = PLAYBOOKS.find((p) => p.id === "OP-COLLECT")!
    const proposal = fillPlaybook(collect, {
      invoices: [INVOICE],
      emails: ["A@Example.com", "b@example.com"],
    })
    if ("error" in proposal) throw new Error(proposal.error)
    expect(proposal.grants).toEqual([
      expect.objectContaining({
        tool: "gmail_draft",
        pins: { to: ["A@Example.com", "b@example.com"] },
        maxUses: 6,
      }),
    ])
    expect(proposal.criteria[0].evidence).toEqual({
      kind: "tool_verified",
      tool: "gmail_draft",
      atLeast: 2,
    })
    expect(proposal.subjects).toEqual({ invoices: [INVOICE] })
    // The form's 10 clients: three drafts each, within the 50 ceiling
    const many = fillPlaybook(collect, LONGEST)
    if ("error" in many) throw new Error(many.error)
    expect(many.grants[0].maxUses).toBe(30)
  })

  it("refuses missing required slots", () => {
    const collect = PLAYBOOKS.find((p) => p.id === "OP-COLLECT")!
    expect(fillPlaybook(collect, { invoices: [INVOICE] })).toHaveProperty("error")
    const compare = PLAYBOOKS.find((p) => p.id === "OP-COMPARE")!
    expect(fillPlaybook(compare, {})).toHaveProperty("error")
    // The sheet is optional: without it the person marks the comparison (OF-19), no grant
    const noSheet = fillPlaybook(compare, { text: "A 1 TB SSD under ₹6,000" })
    if ("error" in noSheet) throw new Error(noSheet.error)
    expect(noSheet.grants).toEqual([])
    expect(noSheet.criteria[0].evidence).toEqual({ kind: "person_confirmed" })
  })
})

describe("the picker shows only runnable playbooks (OT-PB-02)", () => {
  it("hides any playbook with a need not met", () => {
    const shown = (needs: Need[]) => runnable(new Set(needs)).map((p) => p.id)
    expect(shown([])).toEqual([])
    expect(shown(["ledger"])).toEqual(["OP-BOOKS"])
    expect(shown(["ledger", "google.gmail"]).sort()).toEqual(["OP-BOOKS", "OP-COLLECT"])
    expect(shown(["radar"])).toEqual(["OP-COMPLY"])
    expect(shown(["web"])).toEqual(["OP-COMPARE"])
    expect(shown(["google.calendar"])).toEqual(["OP-MEET"])
  })
})

describe("on the database", () => {
  let pg: TestDb
  let user: string

  const env = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  }
  const ON = {
    KRIYA_OPERATOR_MANDATES: "on",
    KRIYA_OPERATOR_PLAYBOOKS: "on",
    KRIYA_AGENTS_GOALS: "on",
    KRIYA_AGENTS_INBOX: "on",
    KRIYA_AGENTS_LEDGER: "on",
  }

  beforeEach(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    user = await createUser(pg)
    state.user = user
    env(ON)
    process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
    await pg.query(
      "update kriya.plans set ledger_enabled = true, max_goals = 10, max_schedules = 20"
    )
    await asUser(pg, user, async (tx) => {
      await tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Lekha', 'r', 'g')",
        [user]
      )
    })
  })
  afterEach(() => env(Object.fromEntries(Object.keys(ON).map((k) => [k, undefined]))))

  it("every playbook's proposal is accepted as the person's (OT-PB-01)", async () => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.invoices (user_id, supplier, client, place_of_supply, items, taxable_paise, total_paise, status, fy, number, number_text, due_date)
       values ($1, '{}', '{}', '29', '[{}]', 100, 100, 'issued', '2026-27', 1, 'INV/1', '2026-10-01') returning id`,
      [user]
    )
    const slots: Slots = {
      invoices: [rows[0].id],
      emails: ["a@example.com"],
      sheet: LONGEST.sheet,
      text: "A 1 TB SSD under ₹6,000",
      date: "2026-10",
    }
    for (const playbook of PLAYBOOKS) {
      const proposal = fillPlaybook(playbook, slots)
      if ("error" in proposal) throw new Error(proposal.error)
      const result = await proposeMandate(
        { userId: user, agentId: "a1", proposedBy: "person" },
        proposal
      )
      expect(result, `${playbook.id}: ${JSON.stringify(result)}`).toHaveProperty(
        "mandateId"
      )
      // Five is also the proposal limit; clear for the next one
      await pg.query(
        "update kriya.mandates set status = 'declined' where status = 'proposed'"
      )
    }
    const stored = await pg.query<{
      playbook_id: string
      playbook_version: number
      proposed_by: string
      origin_thread_id: string | null
    }>(
      "select playbook_id, playbook_version, proposed_by, origin_thread_id from kriya.mandates order by playbook_id"
    )
    expect(stored.rows.map((r) => r.playbook_id)).toEqual([
      "OP-BOOKS",
      "OP-COLLECT",
      "OP-COMPARE",
      "OP-COMPLY",
      "OP-MEET",
    ])
    for (const r of stored.rows) {
      expect(r).toMatchObject({
        playbook_version: PLAYBOOKS.find((p) => p.id === r.playbook_id)!.version,
        proposed_by: "person",
        origin_thread_id: null,
      })
    }
  })

  it("an agent can't name a playbook that doesn't exist", async () => {
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    const result = await proposeMandate(
      { userId: user, threadId: "t1", agentId: "a1" },
      {
        title: "x",
        objective: "y",
        playbookId: "OP-NOPE",
        criteria: [{ text: "z", evidence: { kind: "person_confirmed" } }],
        dueInDays: 3,
      }
    )
    expect(result).toMatchObject({ fields: { playbookId: expect.any(String) } })
  })

  it("proposeFromPlaybook: the person's proposal, refused when off, unmet or not theirs", async () => {
    const ok = await proposeFromPlaybook("OP-BOOKS", { date: "2026-10" }, "a1")
    expect(ok).toHaveProperty("mandateId")
    const { rows } = await pg.query("select proposed_by, playbook_id from kriya.mandates")
    expect(rows).toEqual([{ proposed_by: "person", playbook_id: "OP-BOOKS" }])
    // No Gmail connected: OP-COLLECT isn't runnable
    expect(
      await proposeFromPlaybook(
        "OP-COLLECT",
        { invoices: [INVOICE], emails: ["a@example.com"] },
        "a1"
      )
    ).toHaveProperty("error")
    expect(await proposeFromPlaybook("OP-NOPE", {}, "a1")).toHaveProperty("error")
    expect(
      await proposeFromPlaybook("OP-BOOKS", { date: "2026-10" }, "someone-else")
    ).toHaveProperty("error")
    env({ KRIYA_OPERATOR_PLAYBOOKS: "off" })
    expect(
      await proposeFromPlaybook("OP-BOOKS", { date: "2026-10" }, "a1")
    ).toHaveProperty("error")
  })

  // An approved OP-BOOKS job on goal g1 (thread tg) with one check-in schedule
  async function booksJob() {
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('tg', $1, 'a1')",
      [user]
    )
    await pg.query(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ('g1', $1, 'a1', 'tg', 'Books')",
      [user]
    )
    await pg.query(
      `insert into kriya.mandates (id, user_id, agent_id, title, objective, criteria, due_at, proposed_by, playbook_id, playbook_version)
       values ('m1', $1, 'a1', 'Books', 'Close October',
         '[{"id":"c1","text":"Every bill confirmed","evidence":{"kind":"ledger_confirmed"}}]',
         now() + interval '10 days', 'person', 'OP-BOOKS', 1)`,
      [user]
    )
    await pg.query(
      "update kriya.mandates set status = 'active', goal_id = 'g1', approved_at = now() where id = 'm1'"
    )
  }

  it("a playbook job's scheduled runs carry the playbook as workflowId (OT-PB-03)", async () => {
    await booksJob()
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
    for (const [id, thread, goal] of [
      ["s-job", "tg", "g1"],
      ["s-plain", "t1", null],
    ])
      await pg.query(
        `insert into kriya.schedules (id, user_id, agent_id, thread_id, goal_id, kind, prompt, rule, next_run_at, approved_at)
         values ($1, $2, 'a1', $3, $4, 'recurring', 'Check in', '{"freq":"daily","at":"09:00"}', now() - interval '1 minute', now())`,
        [id, user, thread, goal]
      )
    for (const run of await claimDueSchedules()) await runDue(run)
    const { rows } = await pg.query<{
      thread_id: string
      input: Record<string, unknown>
    }>("select thread_id, input from kriya.tasks order by thread_id")
    const byThread = Object.fromEntries(rows.map((r) => [r.thread_id, r.input]))
    expect(byThread.tg).toMatchObject({ channel: "schedule", workflowId: "OP-BOOKS" })
    // A schedule without a job: the same input as before, no workflowId key
    expect(Object.keys(byThread.t1).sort()).toEqual([
      "agentId",
      "channel",
      "messageId",
      "scheduleId",
    ])
  })

  it("ledger entries drafted in the job's thread join it; done only once confirmed", async () => {
    await booksJob()
    const {
      rows: [task],
    } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
       values ($1, 'tg', '{"messageId":"m","agentId":"a1","channel":"schedule"}', 'free', 'budget', now() + interval '1 hour', 10, 1000, 'succeeded') returning id`,
      [user]
    )
    const {
      rows: [entry],
    } = await pg.query<{ id: string }>(
      `insert into kriya.ledger_entries (user_id, kind, status, entry_date, taxable_paise, total_paise, created_by, task_id)
       values ($1, 'expense', 'draft', current_date, 100, 100, 'agent', $2) returning id`,
      [user, task.id]
    )
    await reviewMandates()
    const job = async () =>
      (
        await pg.query<{ status: string; subjects: { ledger?: string[] } }>(
          "select status, subjects from kriya.mandates"
        )
      ).rows[0]
    expect((await job()).subjects.ledger).toEqual([entry.id])
    expect((await job()).status).toBe("active")
    await pg.query(
      "update kriya.ledger_entries set status = 'confirmed', confirmed_at = now() where id = $1",
      [entry.id]
    )
    await reviewMandates()
    expect((await job()).status).toBe("completed")
  })
})
