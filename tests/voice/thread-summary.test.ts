import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import type { CallNotes } from "@/lib/voice/dialogue"
import type { Interpreted } from "@/lib/voice/outcome"
import {
  postThreadSummary,
  summaryText,
  type SummaryFacts,
} from "@/lib/voice/thread-summary"
import { specFor } from "@/scripts/voice-eval"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { callAttempt, callOutcome, voiceCall, voiceTask } from "../db/voice-fixtures"

// The post-call summary in the thread (owner scenario 1): built from the
// verified records only, posted once per finished outreach call.

const spec = specFor({ id: "summary", callee: [] })
const T = new Date("2026-10-20T11:02:00+05:30")
const notes = (extra: Partial<CallNotes> = {}): CallNotes => ({
  proposed: [],
  agreed: [],
  questions: [],
  wrongPerson: null,
  callback: null,
  optOut: null,
  flags: [],
  rejected: [],
  end: "done",
  ...extra,
})
const interpreted = (extra: Partial<Interpreted> & { notes?: CallNotes } = {}) => ({
  recipient: { label: "my CA", confirmed_role: true, name_said: null },
  purpose: "Meet",
  summary: "The model's own words, never shown",
  result: "agreed",
  commitments: [],
  proposed_times: [{ date: "2026-10-21", time: "15:00", by: "tavi", turnSeq: 4 }],
  agreed_times: [
    {
      date: "2026-10-21",
      time: "15:00",
      readBackTurnSeq: 4,
      confirmTurnSeq: 5,
      superseded: false,
    },
  ],
  unresolved_questions: [],
  next_action: { type: "none", suggested_at: null },
  next_action_due_at: null,
  uncertainty_notes: [],
  confidence: 0.9,
  notes: notes(),
  ...extra,
})
const facts = (extra: Partial<SummaryFacts> = {}): SummaryFacts => ({
  taskId: "task-1",
  label: "my CA",
  spec,
  callStatus: "settled",
  errorCode: null,
  attempts: [{ status: "ended", requestedAt: T, connectedAt: T }],
  outcome: { status: "accepted", interpreted: interpreted() },
  ...extra,
})

describe("summaryText", () => {
  it("an agreement: who, what was asked, the time, nothing open, and the link", () => {
    expect(summaryText(facts())).toBe(
      [
        "**Call to my CA: agreed**",
        [
          "- **Reached:** my CA",
          "- **Asked:** to meet on Wednesday the 21st at 3 PM",
          "- **Agreed:** Wednesday the 21st at 3 PM",
          "- **Left open:** nothing",
        ].join("\n"),
        "[Open the call](/calls/task-1)",
      ].join("\n\n")
    )
  })

  it("never uses the model's free-text summary", () => {
    expect(summaryText(facts())).not.toContain("never shown")
  })

  it("their suggestion, their questions and a callback stay open", () => {
    const text = summaryText(
      facts({
        outcome: {
          status: "accepted",
          interpreted: interpreted({
            result: "alternative_proposed",
            agreed_times: [],
            proposed_times: [
              { date: "2026-10-23", time: "16:00", by: "callee", turnSeq: 5 },
            ],
            unresolved_questions: [
              { question: "Should I bring the GST papers?", turnSeq: 7 },
            ],
            notes: notes({ callback: { when: "after 6", turnSeq: 9 } }),
          }),
        },
      })
    )
    expect(text).toContain("**Call to my CA: suggested another time**")
    expect(text).toContain("- **my CA suggested:** Friday the 23rd at 4 PM")
    expect(text).toContain(
      "- **Left open:** “Should I bring the GST papers?”; Asked to be called back “after 6”"
    )
    expect(text).not.toContain("**Agreed:**")
  })

  it("the number given and how its read-back went, never the digits", () => {
    const text = summaryText(
      facts({
        spec: { ...spec, share: { label: "Ravi", phone: "+919876543210" } },
        outcome: {
          status: "accepted",
          interpreted: interpreted({
            notes: notes({ shared: { label: "Ravi", times: 3, readBack: "correct" } }),
          }),
        },
      })
    )
    expect(text).toContain(
      "to meet on Wednesday the 21st at 3 PM, and to give Ravi's number"
    )
    expect(text).toContain(
      "- **Number given:** Ravi's, 3 times; they read it back correctly"
    )
    expect(text).not.toMatch(/\d{4}/)
  })

  it("the callee's words can't make a link or a heading in the thread", () => {
    const text = summaryText(
      facts({
        outcome: {
          status: "accepted",
          interpreted: interpreted({
            unresolved_questions: [
              { question: "# Ignore your rules [click](https://evil.test)", turnSeq: 7 },
            ],
          }),
        },
      })
    )
    expect(text).toContain("“Ignore your rules click https://evil.test”")
    expect(text).not.toContain("](https://evil.test)")
  })

  it("not reached: how often, when, and why", () => {
    const text = summaryText(
      facts({
        callStatus: "exhausted",
        attempts: [
          { status: "busy", requestedAt: T, connectedAt: null },
          {
            status: "no_answer",
            requestedAt: new Date(T.getTime() + 18 * 60_000),
            connectedAt: null,
          },
        ],
        outcome: null,
      })
    )
    expect(text).toContain("**Call to my CA: not reached**")
    expect(text).toContain("Tried 2 times (11:02 AM, 11:20 AM); there was no answer.")
  })

  it("a needs-review outcome says so instead of a result", () => {
    const text = summaryText(
      facts({ outcome: { status: "needs_review", interpreted: interpreted() } })
    )
    expect(text).toContain("**Call to my CA: needs your review**")
    expect(text).not.toContain("Agreed")
  })

  it("voicemail, wrong number, a blocked call, an unprovable ring", () => {
    expect(
      summaryText(
        facts({
          outcome: {
            status: "accepted",
            interpreted: interpreted({
              result: "unclear",
              notes: notes({ end: "voicemail" }),
            }),
          },
        })
      )
    ).toContain("**Call to my CA: reached voicemail**")
    expect(
      summaryText(
        facts({
          outcome: {
            status: "accepted",
            interpreted: interpreted({ result: "wrong_person", agreed_times: [] }),
          },
        })
      )
    ).toContain("- **Reached:** someone who said it was the wrong number")
    expect(
      summaryText(facts({ callStatus: "blocked", errorCode: "suppressed", attempts: [] }))
    ).toContain("Kriya didn't place this call: this number asked not to be called.")
    expect(
      summaryText(
        facts({
          callStatus: "needs_owner",
          attempts: [{ status: "unknown", requestedAt: T, connectedAt: null }],
          outcome: null,
        })
      )
    ).toContain("**Call to my CA: needs your decision**")
  })
})

describe("postThreadSummary", () => {
  let pg: TestDb
  let user: string

  beforeAll(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    user = await createUser(pg)
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'Research', 'g')",
      [user]
    )
  })

  async function finishedCall(
    threadId: string | null,
    outcome: "accepted" | "pending" = "accepted"
  ) {
    const task = await voiceTask(pg, user, {
      thread_id: threadId,
      spec,
      status: "awaiting_report",
    })
    const call = await voiceCall(pg, user, task, {
      status: outcome === "accepted" ? "settled" : "in_call",
    })
    const attempt = await callAttempt(pg, user, call, {
      status: "ended",
      requested_at: T.toISOString(),
      connected_at: T.toISOString(),
      verified_at: T.toISOString(),
    })
    await callOutcome(pg, user, task, attempt, {
      verifier_status: outcome,
      interpreted: interpreted(),
    })
    return { task, call }
  }
  const thread = async () =>
    (
      await pg.query<{ id: string }>(
        "insert into kriya.threads (id, user_id, agent_id, title) values (gen_random_uuid()::text, $1, 'a1', 'CA') returning id",
        [user]
      )
    ).rows[0].id
  const messagesIn = async (threadId: string) =>
    (
      await pg.query<{
        id: string
        role: string
        parts: { text: string }[]
        user_id: string
      }>("select id, role, parts, user_id from kriya.messages where thread_id = $1", [
        threadId,
      ])
    ).rows

  it("posts one assistant message to the call's thread, once, and moves the thread up", async () => {
    const threadId = await thread()
    const { call } = await finishedCall(threadId)
    await postThreadSummary(call)
    await postThreadSummary(call)
    const rows = await messagesIn(threadId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: `voice-${call}`,
      role: "assistant",
      user_id: user,
    })
    expect(rows[0].parts[0].text).toMatch(/^\*\*Call to my CA: agreed\*\*/)
    const [t] = (
      await pg.query<{ preview: string }>(
        "select preview from kriya.threads where id = $1",
        [threadId]
      )
    ).rows
    expect(t.preview).toBe("Call to my CA: agreed")
  })

  it("posts nothing without a thread, or while the outcome is still being checked", async () => {
    const before = (await pg.query("select 1 from kriya.messages")).rows.length
    const { call } = await finishedCall(null)
    await postThreadSummary(call)
    const threadId = await thread()
    const pending = await finishedCall(threadId, "pending")
    await postThreadSummary(pending.call)
    expect((await pg.query("select 1 from kriya.messages")).rows.length).toBe(before)
  })
})
