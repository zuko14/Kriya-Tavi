import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { privileged, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import type { Agent, Criterion, EpisodeAction } from "@/db/schema"
import { createMandateTools } from "@/lib/agent/tools"
import { renderTemplate } from "@/lib/documents/templates"
import {
  allMet,
  loadEvidence,
  reportData,
  storeVerdict,
  verdict,
  type Evidence,
} from "@/lib/operator/verdict"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// The verdict (O5, OD-05/06): pure, over rows. OT-VDT-01 each evidence kind
// met and not met; OT-VDT-02 deleted or failed records don't count;
// OT-VDT-03 mandate_report stores a verdict and never a status; OT-VDT-04
// another person's rows never count; OT-VDT-05 the handover report.

const action = (
  tool: string,
  status: "verified" | "failed" = "verified"
): EpisodeAction => ({
  executionId: `x-${tool}-${status}`,
  tool,
  title: tool,
  risk: "R3",
  verification: { status, method: "api_readback", evidence: [] },
})
const none: Evidence = {
  episodes: [],
  calls: [],
  invoices: [],
  ledger: [],
  confirmed: [],
}
const c = (id: string, evidence: Criterion["evidence"]): Criterion => ({
  id,
  text: `line ${id}`,
  evidence,
})

describe("each evidence kind (OT-VDT-01, OT-VDT-02)", () => {
  it("tool_verified counts verified runs of that tool, at least N", () => {
    const criteria = [c("c1", { kind: "tool_verified", tool: "gmail_draft", atLeast: 2 })]
    const one = {
      ...none,
      episodes: [{ id: "e1", done: [action("gmail_draft")], files: [] }],
    }
    expect(verdict(criteria, {}, one)[0].met).toBe(false)
    const two = {
      ...none,
      episodes: [
        { id: "e1", done: [action("gmail_draft")], files: [] },
        { id: "e2", done: [action("gmail_draft"), action("sheets_append")], files: [] },
      ],
    }
    expect(verdict(criteria, {}, two)[0]).toEqual({
      id: "c1",
      met: true,
      by: "evidence",
      refs: [
        { kind: "episode", id: "e1" },
        { kind: "episode", id: "e2" },
      ],
    })
    // A run whose own check failed is no proof
    const failed = {
      ...none,
      episodes: [
        {
          id: "e1",
          done: [action("gmail_draft", "failed"), action("gmail_draft", "failed")],
          files: [],
        },
      ],
    }
    expect(verdict(criteria, {}, failed)[0].met).toBe(false)
  })

  it("call_outcome needs an accepted outcome with one of the results", () => {
    const criteria = [c("c1", { kind: "call_outcome", results: ["agreed"] })]
    const call = (result: string, verifier: string) => ({
      ...none,
      calls: [{ voiceTaskId: "v1", result, verifier }],
    })
    expect(verdict(criteria, {}, call("agreed", "accepted"))[0]).toMatchObject({
      met: true,
      refs: [{ kind: "voice_task", id: "v1" }],
    })
    expect(verdict(criteria, {}, call("agreed", "needs_review"))[0].met).toBe(false)
    expect(verdict(criteria, {}, call("declined", "accepted"))[0].met).toBe(false)
  })

  it("invoice_paid and ledger_confirmed need every listed row, and at least one", () => {
    const criteria = [
      c("c1", { kind: "invoice_paid" }),
      c("c2", { kind: "ledger_confirmed" }),
    ]
    const subjects = { invoices: ["i1", "i2"], ledger: ["l1"] }
    const partly = {
      ...none,
      invoices: [
        { id: "i1", status: "paid" },
        { id: "i2", status: "issued" },
      ],
      ledger: [{ id: "l1", status: "confirmed" }],
    }
    expect(verdict(criteria, subjects, partly).map((r) => r.met)).toEqual([false, true])
    // A listed invoice that's gone (deleted, or someone else's) never counts
    const missing = { ...partly, invoices: [{ id: "i1", status: "paid" }] }
    expect(verdict(criteria, subjects, missing)[0].met).toBe(false)
    const all = {
      ...partly,
      invoices: partly.invoices.map((i) => ({ ...i, status: "paid" })),
    }
    expect(verdict(criteria, subjects, all)[0]).toMatchObject({
      met: true,
      refs: [
        { kind: "invoice", id: "i1" },
        { kind: "invoice", id: "i2" },
      ],
    })
    expect(verdict(criteria, {}, all).map((r) => r.met)).toEqual([false, false])
  })

  it("file_created needs a file in a record; person_confirmed only the person's tick", () => {
    const criteria = [
      c("c1", { kind: "file_created" }),
      c("c2", { kind: "person_confirmed" }),
    ]
    expect(verdict(criteria, {}, none).map((r) => r.met)).toEqual([false, false])
    const done = {
      ...none,
      episodes: [{ id: "e1", done: [], files: ["f1"] }],
      confirmed: ["c2"],
    }
    expect(verdict(criteria, {}, done)).toEqual([
      { id: "c1", met: true, by: "evidence", refs: [{ kind: "file", id: "f1" }] },
      { id: "c2", met: true, by: "person", refs: [] },
    ])
    expect(allMet(verdict(criteria, {}, done))).toBe(true)
  })
})

describe("rows from the database (OT-VDT-02, OT-VDT-03, OT-VDT-04)", () => {
  let pg: TestDb
  let alice: string
  let bob: string

  const episode = async (user: string, thread: string, deleted = false) =>
    (
      await pg.query<{ id: string }>(
        `insert into kriya.episodes (user_id, thread_id, done, seq, hash, deleted_at)
         values ($1, $2, $3, (select coalesce(max(seq), 0) + 1 from kriya.episodes where user_id = $1), 'h', $4)
         returning id`,
        [
          user,
          thread,
          JSON.stringify([action("gmail_draft")]),
          deleted ? new Date() : null,
        ]
      )
    ).rows[0].id

  beforeEach(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    alice = await createUser(pg)
    bob = await createUser(pg)
    for (const [user, agent, thread] of [
      [alice, "a1", "tg"],
      [bob, "b1", "tb"],
    ]) {
      await pg.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
        [agent, user]
      )
      await pg.query(
        "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
        [thread, user, agent]
      )
    }
    await pg.query(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title) values ('g1', $1, 'a1', 'tg', 'Collect')",
      [alice]
    )
    await pg.query(
      `insert into kriya.mandates (id, user_id, agent_id, title, objective, criteria, due_at, proposed_by)
       values ('m1', $1, 'a1', 'Collect', 'Get paid', $2, now() + interval '7 days', 'agent')`,
      [
        alice,
        JSON.stringify([
          c("c1", { kind: "tool_verified", tool: "gmail_draft" }),
          c("c2", { kind: "person_confirmed" }),
        ]),
      ]
    )
    await pg.query(
      "update kriya.mandates set status = 'active', goal_id = 'g1' where id = 'm1'"
    )
  })

  const job = async () =>
    (await privileged.select().from(schema.mandates)).find((m) => m.id === "m1")!

  it("leaves out deleted records and other people's", async () => {
    await episode(alice, "tg", true)
    // Bob's record, even in a thread with the same id pattern, is his
    await episode(bob, "tb")
    const evidence = await loadEvidence(privileged, alice, await job())
    expect(evidence.episodes).toEqual([])
    expect(verdict((await job()).criteria, {}, evidence)[0].met).toBe(false)
    const mine = await episode(alice, "tg")
    expect(
      (await loadEvidence(privileged, alice, await job())).episodes.map((e) => e.id)
    ).toEqual([mine])
  })

  it("never counts another person's invoice, even when the job lists it", async () => {
    await pg.query("update kriya.plans set ledger_enabled = true")
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.invoices (user_id, supplier, client, place_of_supply, items, taxable_paise, total_paise, status, fy, number, number_text)
       values ($1, '{}', '{}', '29', '[{}]', 100, 100, 'paid', '2026-27', 1, 'INV/1') returning id`,
      [bob]
    )
    const evidence = await loadEvidence(privileged, alice, {
      ...(await job()),
      subjects: { invoices: [rows[0].id] },
    })
    expect(evidence.invoices).toEqual([])
  })

  it("counts the job's own report PDF as a file it made (OF-19)", async () => {
    const file = async (user: string, name: string, origin: string, status = "ready") =>
      (
        await pg.query<{ id: string }>(
          `insert into kriya.files (user_id, name, mime, size_bytes, origin, status, sha256)
           values ($1, $2, 'application/pdf', 10, $3, $4, repeat('a', 64)) returning id`,
          [user, name, origin, status]
        )
      ).rows[0].id
    // None of these is this job's report: another person's, an upload, another job's, unfinished
    await file(bob, "kriya-job-m1.pdf", "generated")
    await file(alice, "kriya-job-m1.pdf", "upload")
    await file(alice, "kriya-job-m2.pdf", "generated")
    await file(alice, "kriya-job-m1.pdf", "generated", "pending")
    const criteria = [c("c1", { kind: "file_created" })]
    const before = await loadEvidence(privileged, alice, await job())
    expect(before.reports).toEqual([])
    expect(verdict(criteria, {}, before)[0].met).toBe(false)
    const report = await file(alice, "kriya-job-m1.pdf", "generated")
    const after = await loadEvidence(privileged, alice, await job())
    expect(verdict(criteria, {}, after)[0]).toEqual({
      id: "c1",
      met: true,
      by: "evidence",
      refs: [{ kind: "file", id: report }],
    })
  })

  it("mandate_report stores a verdict and never touches the status (OT-VDT-03)", async () => {
    await episode(alice, "tg")
    const tools = createMandateTools(
      { current: () => ({ id: "a1" }) as Agent, userId: alice, threadId: "tg" },
      { reports: true }
    )
    const result = await tools.mandate_report!.execute!({}, {
      toolCallId: "r1",
      messages: [],
    } as never)
    expect(result).toMatchObject({ allMet: false })
    const stored = await job()
    expect(stored.status).toBe("active")
    expect(stored.verdict?.map((r) => r.met)).toEqual([true, false])
    expect(stored.lastEvidenceAt).not.toBeNull()
  })

  it("the same proof in another row order isn't new evidence (rows have no fixed order)", async () => {
    const e1 = await episode(alice, "tg")
    const e2 = await episode(alice, "tg")
    // A stored verdict listing the same two records the other way round
    await pg.query(
      `update kriya.mandates set last_evidence_at = '2026-01-01T00:00:00Z', verdict = $1 where id = 'm1'`,
      [
        JSON.stringify([
          {
            id: "c1",
            met: true,
            by: "evidence",
            refs: [
              { kind: "episode", id: e2 },
              { kind: "episode", id: e1 },
            ],
          },
          { id: "c2", met: false, by: null, refs: [] },
        ]),
      ]
    )
    const { changed } = await storeVerdict(privileged, alice, await job())
    expect(changed).toBe(false)
    expect((await job()).lastEvidenceAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z")
  })

  it("is only offered with operator.reports", () => {
    const env = { current: () => ({ id: "a1" }) as Agent, userId: alice, threadId: "tg" }
    expect(Object.keys(createMandateTools(env, { reports: false }))).not.toContain(
      "mandate_report"
    )
  })
})

describe("the handover report (OT-VDT-05)", () => {
  it("lists met lines with their proof, unmet as not confirmed, and the person's ticks", () => {
    const criteria = [
      c("c1", { kind: "tool_verified", tool: "gmail_draft" }),
      c("c2", { kind: "invoice_paid" }),
      c("c3", { kind: "person_confirmed" }),
    ]
    const results = [
      {
        id: "c1",
        met: true,
        by: "evidence" as const,
        refs: [
          { kind: "episode" as const, id: "e1" },
          { kind: "episode" as const, id: "e2" },
        ],
      },
      { id: "c2", met: false, by: null, refs: [] },
      { id: "c3", met: true, by: "person" as const, refs: [] },
    ]
    const data = reportData(
      {
        title: "Get invoice 12 paid",
        objective: "Chase it",
        status: "closed",
        dueAt: new Date("2026-11-01T00:00:00Z"),
        criteria,
      },
      results,
      new Date("2026-10-30T10:00:00Z")
    )
    const rows = data.sections[0].table!.rows
    expect(rows).toEqual([
      ["line c1", "Verified", "2 records"],
      ["line c2", "Not confirmed", "—"],
      ["line c3", "Confirmed by you", "—"],
    ])
    const { html } = renderTemplate("report", data)
    expect(html).toContain("Not confirmed")
    expect(html).toContain("Confirmed by you")
    expect(html).toContain("Get invoice 12 paid")
  })
})
