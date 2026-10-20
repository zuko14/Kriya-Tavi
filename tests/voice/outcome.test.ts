import { drizzle } from "drizzle-orm/pglite"
import { MockLanguageModelV4 } from "ai/test"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { clock } from "@/lib/voice/schedule"
import { settleCall } from "@/lib/voice/verify"

import type { CallNotes, Turn } from "@/lib/voice/dialogue"
import {
  checkOutcome,
  extractOutcome,
  observedFrom,
  type Interpreted,
} from "@/lib/voice/outcome"
import { specFor } from "@/scripts/voice-eval"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"
import { callAttempt, seed, transition, voiceCall, voiceTask } from "../db/voice-fixtures"

// Outcomes are checked by code against the notes the guards accepted and
// the stored turns (CONVERSATION §6–7, EVALUATION_PLAN §6). The model's
// extraction is an interpretation; it never makes a call a success.

const spec = specFor({ id: "outcome", callee: [] })

const turns: Turn[] = [
  { seq: 0, speaker: "tavi", text: "Hello, this is Kriya Tavi…", confidence: null },
  { seq: 1, speaker: "callee", text: "Hello?", confidence: null },
  { seq: 2, speaker: "tavi", text: "Am I speaking with Asha's CA?", confidence: null },
  { seq: 3, speaker: "callee", text: "Yes.", confidence: null },
  {
    seq: 4,
    speaker: "tavi",
    text: "Asha would like to meet you on Wednesday the 21st at 3 PM. Would that work for you?",
    confidence: null,
  },
  { seq: 5, speaker: "callee", text: "Yes, that works.", confidence: null },
]

const notes = (extra: Partial<CallNotes> = {}): CallNotes => ({
  proposed: [{ date: "2026-10-21", time: "15:00", by: "tavi", turnSeq: 4 }],
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

const AGREED = {
  date: "2026-10-21",
  time: "15:00",
  readBackTurnSeq: 4,
  confirmTurnSeq: 5,
  superseded: false,
}

const interpreted = (extra: Partial<Interpreted> = {}): Interpreted => ({
  recipient: { label: "my CA", confirmed_role: true, name_said: null },
  purpose: "Meet tomorrow at 3 PM",
  summary: "The CA agreed to meet Asha on Wednesday at 3 PM.",
  result: "agreed",
  commitments: [],
  proposed_times: [{ date: "2026-10-21", time: "15:00", by: "tavi", turnSeq: 4 }],
  agreed_times: [AGREED],
  unresolved_questions: [],
  next_action: { type: "none", suggested_at: null },
  next_action_due_at: null,
  uncertainty_notes: [],
  confidence: 0.9,
  ...extra,
})

const input = (n: CallNotes) => ({ spec, turns, notes: n })

describe("checkOutcome", () => {
  it("accepts an outcome the notes and turns support", () => {
    const checked = checkOutcome(interpreted(), input(notes({ agreed: [AGREED] })))
    expect(checked.status).toBe("accepted")
    expect(checked.interpreted.result).toBe("agreed")
  })

  it("T-VER-01 'he agreed to 3 PM' with no guarded agreement is not agreed", () => {
    const checked = checkOutcome(interpreted(), input(notes()))
    expect(checked.status).toBe("needs_review")
    expect(checked.interpreted.result).not.toBe("agreed")
    expect(checked.interpreted.agreed_times).toEqual([])
    // Demoted, not dropped: the time is still there as a proposal
    expect(checked.interpreted.proposed_times).toContainEqual(
      expect.objectContaining({ date: "2026-10-21", time: "15:00" })
    )
    expect(checked.interpreted.uncertainty_notes.join(" ")).toMatch(/no agreement/)
  })

  it("T-VER-02 an item citing a turn that doesn't exist is refused", () => {
    const checked = checkOutcome(
      interpreted({ agreed_times: [{ ...AGREED, confirmTurnSeq: 99 }] }),
      input(notes({ agreed: [AGREED] }))
    )
    expect(checked.status).toBe("needs_review")
    expect(checked.reasons.join(" ")).toMatch(/turn 99/)
  })

  it("a proposed time must be in the words of its turn", () => {
    const checked = checkOutcome(
      interpreted({
        result: "alternative_proposed",
        agreed_times: [],
        proposed_times: [{ date: "2026-10-21", time: "17:00", by: "callee", turnSeq: 5 }],
      }),
      input(notes())
    )
    expect(checked.status).toBe("needs_review")
    expect(checked.reasons.join(" ")).toMatch(/turn 5 doesn't say 17:00/)
  })

  it("no commitment for the owner that Tavi didn't have authority for", () => {
    const checked = checkOutcome(
      interpreted({
        commitments: [
          { by: "owner_via_tavi", what: "Asha will pay ₹50,000", turnSeq: 5 },
        ],
      }),
      input(notes({ agreed: [AGREED] }))
    )
    expect(checked.status).toBe("needs_review")
    expect(checked.reasons.join(" ")).toMatch(/commitment/)
  })

  it("the result can't contradict the notes (wrong person, agreement)", () => {
    expect(
      checkOutcome(
        interpreted({ result: "declined", agreed_times: [] }),
        input(notes({ wrongPerson: { turnSeq: 3 } }))
      ).status
    ).toBe("needs_review")
    expect(
      checkOutcome(
        interpreted({ result: "unclear", agreed_times: [] }),
        input(notes({ agreed: [AGREED] }))
      ).status
    ).toBe("needs_review")
  })
})

describe("observedFrom", () => {
  it("is built from the attempt and the stream only", () => {
    const observed = observedFrom(
      {
        id: "a1",
        status: "ended",
        providerCallId: "p1",
        answeredAt: new Date("2026-10-20T10:00:00Z"),
        connectedAt: new Date("2026-10-20T10:00:01Z"),
        endedAt: new Date("2026-10-20T10:02:00Z"),
        billableSeconds: 120,
        endReason: "tavi_hangup",
      },
      { disclosurePlayed: true, turns: [1, 2, 3], eventIds: ["e1"] }
    )
    expect(observed).toEqual({
      connection_status: "connected",
      provider_call_id: "p1",
      answered_at: "2026-10-20T10:00:00.000Z",
      ended_at: "2026-10-20T10:02:00.000Z",
      billable_seconds: 120,
      ended_by: "tavi",
      disclosure_played: true,
      turns: 3,
      transcript_reference: { attemptId: "a1", firstSeq: 1, lastSeq: 3 },
      evidence_references: ["e1"],
    })
  })

  it("an answered call that never streamed isn't a conversation", () => {
    expect(
      observedFrom(
        {
          id: "a1",
          status: "ended",
          providerCallId: "p1",
          answeredAt: new Date(),
          connectedAt: null,
          endedAt: new Date(),
          billableSeconds: null,
          endReason: null,
        },
        { disclosurePlayed: false, turns: [], eventIds: [] }
      ).connection_status
    ).toBe("answered_no_stream")
  })
})

describe("extractOutcome", () => {
  const usage = {
    inputTokens: {
      total: 2000,
      noCache: 2000,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 200, text: 200, reasoning: undefined },
  }
  const model = (id: string, text: string) =>
    new MockLanguageModelV4({
      modelId: id,
      doGenerate: async () => ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    })

  it("returns the model's structured outcome", async () => {
    const primary = model("m/primary", JSON.stringify(interpreted()))
    const result = await extractOutcome({ spec, turns, notes: notes(), model: primary })
    expect(result).toMatchObject({
      model: "m/primary",
      interpreted: { result: "agreed" },
    })
    expect(primary.doGenerateCalls).toHaveLength(1)
  })

  it("T-VER-08 invalid output twice (escalation the second time) gives nothing", async () => {
    const primary = model("m/primary", "{ not json")
    const escalation = model("m/escalation", JSON.stringify({ result: "agreed" }))
    const result = await extractOutcome({
      spec,
      turns,
      notes: notes(),
      model: primary,
      escalation,
    })
    expect(result).toBeNull()
    expect(primary.doGenerateCalls).toHaveLength(1)
    expect(escalation.doGenerateCalls).toHaveLength(1)
  })
})

// T-VER-04…07 (EVALUATION_PLAN §6): "completed" is never taken on anyone's
// word. Against the database: the transition function, its guards, grants
describe("completed only through the transition rules", () => {
  let pg: TestDb
  let user: string
  const T0 = new Date("2026-10-13T14:00:00+05:30")

  beforeAll(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    clock.now = () => new Date(T0)
    user = await createUser(pg)
    await seed(pg, "voice_profiles", { user_id: user })
  })
  afterAll(() => {
    clock.now = () => new Date()
  })

  const awaitingReport = () => voiceTask(pg, user, { status: "awaiting_report" })
  const statusOf = async (table: string, id: string) =>
    (
      await pg.query<{ status: string }>(
        `select status from kriya.${table} where id = $1`,
        [id]
      )
    ).rows[0].status

  it("T-VER-04 a report answered but not played to its last mark isn't delivered; a retry is scheduled", async () => {
    const task = await awaitingReport()
    const call = await voiceCall(pg, user, task, {
      kind: "owner_report",
      status: "in_call",
      attempts: 1,
      max_attempts: 3,
      window_end: new Date(T0.getTime() + 2 * 3_600_000).toISOString(),
    })
    await callAttempt(pg, user, call, {
      status: "ended",
      answered_at: T0.toISOString(),
      connected_at: T0.toISOString(),
      verified_at: T0.toISOString(),
      end_reason: "callee_hangup",
    })
    await settleCall(call)
    const [row] = (
      await pg.query<{ status: string; delivered_at: string | null }>(
        "select status, delivered_at from kriya.voice_calls where id = $1",
        [call]
      )
    ).rows
    expect(row).toEqual({ status: "retry_wait", delivered_at: null })
    expect(await statusOf("voice_tasks", task)).toBe("awaiting_report")
  })

  it("T-VER-05 the person's session can't set a status, and neither can a direct write", async () => {
    const task = await awaitingReport()
    await expect(
      asUser(pg, user, (tx) =>
        tx.query("update kriya.voice_tasks set status = 'completed' where id = $1", [
          task,
        ])
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      pg.query("update kriya.voice_tasks set status = 'completed' where id = $1", [task])
    ).rejects.toThrow(/only through kriya.voice_transition/)
    expect(await statusOf("voice_tasks", task)).toBe("awaiting_report")
  })

  it("T-VER-06 kriya-voice (or any wrong actor) can't complete a task", async () => {
    const task = await awaitingReport()
    for (const actor of ["voice", "owner", "worker", "webhook"]) {
      await expect(
        transition(pg, "task", task, "completed", actor, { result: "agreed" })
      ).rejects.toThrow(/can't move a voice task/)
    }
    expect(await statusOf("voice_tasks", task)).toBe("awaiting_report")
  })

  it("T-VER-07 awaiting_report → completed needs a delivered report call", async () => {
    const task = await awaitingReport()
    const report = await voiceCall(pg, user, task, { kind: "owner_report" })
    await expect(
      transition(pg, "task", task, "completed", "verifier", { result: "agreed" })
    ).rejects.toThrow(/needs a delivered report call/)
    await expect(
      transition(pg, "task", task, "completed", "verifier", {
        result: "agreed",
        voice_call_id: report,
      })
    ).rejects.toThrow(/needs a delivered report call/)
    await pg.query("update kriya.voice_calls set delivered_at = now() where id = $1", [
      report,
    ])
    expect(
      await transition(pg, "task", task, "completed", "verifier", {
        result: "agreed",
        voice_call_id: report,
      })
    ).toBe(true)
  })
})
