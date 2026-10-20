import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { drizzle } from "drizzle-orm/pglite"
import { NextRequest } from "next/server"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

// The calls screens (voice phase 7, UX_AND_INTERACTION_SPEC.md): what the
// server reads and says, the confirmation card, the live stream and the
// proxy prefixes. Rendering runs no effects; actions and the session are
// stubbed, the database is PGlite.

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({
  authenticate: async () => (state.user ? { id: state.user } : null),
  requireUser: async () => ({ id: state.user }),
}))
vi.mock("@/actions/voice", () => ({
  askToConfirmCall: async () => ({ ok: true }),
  confirmVoiceCall: async () => ({ ok: true }),
  declineVoiceCall: async () => ({ ok: true }),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}))
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: null }) } }),
}))

import { GET } from "@/app/api/voice/tasks/[taskId]/stream/route"
import { ConfirmCard } from "@/components/voice/confirm-card"
import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { clock } from "@/lib/voice/schedule"
import {
  confirmCall,
  createDraft,
  declineCall,
  requestConfirmation,
} from "@/lib/voice/tasks"
import { proxy } from "@/proxy"
import { getCall, getCalls } from "@/queries/voice"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import {
  callAttempt,
  callOutcome,
  seed,
  voiceCall,
  voiceTask,
} from "../db/voice-fixtures"

const T0 = new Date("2026-10-13T14:00:00+05:30")
let pg: TestDb
let user: string

const draftInput = () => ({
  idempotencyKey: `k-${Math.random()}`,
  recipientLabel: "my CA",
  recipientPhone: "98765 43210",
  purpose: "Ask whether 3 PM tomorrow works",
  goal: {
    type: "schedule_meeting" as const,
    date: "2026-10-14",
    preferred: "15:00",
    acceptable: [{ from: "14:00", to: "17:00" }],
  },
  authority: {
    mayAcceptWithinAcceptable: true,
    mayProposeAlternatives: true,
    mayShareOwnerPhone: false as const,
    mayDiscuss: [],
  },
  mustNot: [],
})

const SPEC = { timezone: "Asia/Kolkata", recipient: { label: "my CA" } }

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  vi.stubEnv("KRIYA_PHONE_HASH_KEY", "k".repeat(48))
  clock.now = () => new Date(T0)
  user = await createUser(pg)
  state.user = user
  await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [user])
  await pg.query(
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
       max_voice_task_cost_micro_inr = 50000000`
  )
  await seed(pg, "voice_access", { user_id: user })
})

afterAll(() => {
  vi.unstubAllEnvs()
  clock.now = () => new Date()
})

// A finished call: an attempt with an outcome
async function finished(result: string, interpreted: unknown, verifier = "accepted") {
  const task = await voiceTask(pg, user, {
    status: "completed",
    result,
    spec: SPEC,
  })
  const call = await voiceCall(pg, user, task, { status: "settled", attempts: 1 })
  const attempt = await callAttempt(pg, user, call, {
    status: "ended",
    connected_at: T0.toISOString(),
  })
  await callOutcome(pg, user, task, attempt, { interpreted, verifier_status: verifier })
  return task
}

describe("what the calls list says", () => {
  it("sorts tasks into live, needs you, upcoming and done, with lines that never overstate", async () => {
    const draft = await createDraft(user, draftInput())
    if (!draft.ok) throw new Error(draft.message)
    const live = await voiceTask(pg, user, { status: "in_progress", spec: SPEC })
    await voiceCall(pg, user, live, { status: "dialing", attempts: 1 })
    const upcoming = await voiceTask(pg, user, { status: "authorized", spec: SPEC })
    await voiceCall(pg, user, upcoming, {
      status: "scheduled",
      available_at: "2026-10-14T09:00:00+05:30",
      not_before: "2026-10-14T09:00:00+05:30",
    })
    const agreed = await finished("agreed", {
      result: "agreed",
      agreed_times: [
        {
          date: "2026-10-14",
          time: "15:00",
          readBackTurnSeq: 4,
          confirmTurnSeq: 5,
          superseded: false,
        },
      ],
      proposed_times: [],
    })
    const busy = await voiceTask(pg, user, {
      status: "completed",
      result: "busy",
      spec: SPEC,
    })
    await voiceCall(pg, user, busy, { status: "exhausted", attempts: 2 })

    const list = await getCalls(user)
    const line = (id: string) => list.find((t) => t.id === id)
    expect(line(draft.taskId)).toMatchObject({
      section: "needs_you",
      line: "Draft: review and confirm",
    })
    expect(line(live)).toMatchObject({ section: "live", line: "Calling now" })
    expect(line(upcoming)).toMatchObject({
      section: "upcoming",
      line: "Will call on Wed 14 Oct at 9:00 AM",
    })
    expect(line(agreed)).toMatchObject({
      section: "done",
      line: "My CA agreed to Wednesday the 14th at 3 PM",
    })
    expect(line(busy)).toMatchObject({ section: "done", line: "Line busy (2 tries)" })
  })

  it("'agreed' only from a verified agreement; a call needing review says so", async () => {
    const review = await voiceTask(pg, user, { status: "needs_owner", spec: SPEC })
    const call = await voiceCall(pg, user, review, { status: "settled", attempts: 1 })
    const attempt = await callAttempt(pg, user, call, { status: "ended" })
    await callOutcome(pg, user, review, attempt, {
      interpreted: { result: "agreed" },
      verifier_status: "needs_review",
    })
    const [row] = (await getCalls(user)).filter((t) => t.id === review)
    expect(row.section).toBe("needs_you")
    expect(row.line).toBe("Needs your review: read what was said before deciding")
    expect(row.line).not.toMatch(/agreed/)
  })

  it("another person's calls are invisible (RLS)", async () => {
    await finished("agreed", { result: "agreed", agreed_times: [] })
    const other = await createUser(pg)
    expect(await getCalls(other)).toEqual([])
  })
})

describe("one call", () => {
  it("the outcome with its verification badge, evidence turns and cut-off turns", async () => {
    const task = await finished("agreed", {
      result: "agreed",
      agreed_times: [
        {
          date: "2026-10-14",
          time: "15:00",
          readBackTurnSeq: 1,
          confirmTurnSeq: 2,
          superseded: false,
        },
      ],
      proposed_times: [],
      unresolved_questions: [{ question: "Is parking available?", turnSeq: 2 }],
    })
    const [{ id: attempt }] = (
      await pg.query<{ id: string }>("select id from kriya.call_attempts")
    ).rows
    for (const [seq, speaker, text, interrupted] of [
      [0, "tavi", "Hello, this is Kriya Tavi…", true],
      [1, "tavi", "So that's Wednesday the 14th at 3 PM?", false],
      [2, "callee", "Yes, that works.", false],
    ] as const) {
      await pg.query(
        "insert into kriya.conversation_turns (user_id, call_attempt_id, seq, speaker, text, interrupted) values ($1, $2, $3, $4, $5, $6)",
        [user, attempt, seq, speaker, text, interrupted]
      )
    }
    const detail = await getCall(user, task)
    expect(detail).toMatchObject({
      hero: "My CA agreed to Wednesday the 14th at 3 PM",
      verified: true,
      agreed: [{ when: "Wednesday the 14th at 3 PM", turn: 2 }],
      questions: [{ question: "Is parking available?", turn: 2 }],
    })
    expect(detail!.turns.map((t) => [t.seq, t.cutOff])).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ])
    const other = await createUser(pg)
    expect(await getCall(other, task)).toBeNull()
  })

  it("a failure is explained in plain words (§6)", async () => {
    const task = await voiceTask(pg, user, {
      status: "failed",
      error_code: "suppressed",
      spec: SPEC,
    })
    expect((await getCall(user, task))?.hero).toBe("I can't call this number.")
  })
})

describe("T-UI-01 the confirmation card", () => {
  it("renders from the server's payload; the full number stays hidden until asked", async () => {
    const draft = await createDraft(user, draftInput())
    if (!draft.ok) throw new Error(draft.message)
    const request = await requestConfirmation(user, draft.taskId)
    if (!request.ok) throw new Error(request.message)
    const html = renderToStaticMarkup(
      createElement(ConfirmCard, {
        taskId: draft.taskId,
        approval: {
          id: request.approvalId,
          payload: request.payload,
          payloadHash: request.payloadHash,
          expiresAt: request.expiresAt.toISOString(),
        },
      })
    )
    expect(html).toContain("an AI assistant calling on behalf of Asha")
    expect(html).toContain("+91 98xxx xxx10")
    expect(html).not.toContain("9876543210")
    // Confirming needs the number to have been shown once
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Confirm &amp; call/)
  })

  it("editing (declining and asking again) makes the old card stale", async () => {
    const draft = await createDraft(user, draftInput())
    if (!draft.ok) throw new Error(draft.message)
    const first = await requestConfirmation(user, draft.taskId)
    if (!first.ok) throw new Error(first.message)
    await declineCall(user, first.approvalId)
    const second = await requestConfirmation(user, draft.taskId)
    if (!second.ok) throw new Error(second.message)
    expect(await confirmCall(user, first.approvalId, first.payloadHash)).toMatchObject({
      ok: false,
      code: "stale_approval",
    })
    expect(await confirmCall(user, second.approvalId, second.payloadHash)).toMatchObject({
      ok: true,
    })
  })
})

describe("the live stream", () => {
  const params = (taskId: string) => ({ params: Promise.resolve({ taskId }) })

  it("is the owner's only: signed out → 401, someone else's task → 404", async () => {
    const task = await voiceTask(pg, user, { status: "authorized", spec: SPEC })
    state.user = ""
    expect((await GET(new Request("https://kriya.test"), params(task))).status).toBe(401)
    state.user = await createUser(pg)
    expect((await GET(new Request("https://kriya.test"), params(task))).status).toBe(404)
    expect(
      (await GET(new Request("https://kriya.test"), params("not-a-uuid"))).status
    ).toBe(404)
  })

  it("sends the task's state first", async () => {
    const task = await voiceTask(pg, user, { status: "authorized", spec: SPEC })
    const abort = new AbortController()
    const response = await GET(
      new Request("https://kriya.test", { signal: abort.signal }),
      params(task)
    )
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/)
    const reader = response.body!.getReader()
    let text = ""
    while (!text.includes('"type":"task"')) {
      text += new TextDecoder().decode((await reader.read()).value)
    }
    abort.abort()
    await reader.cancel()
    expect(text).toContain('"status":"authorized"')
  })
})

describe("proxy prefixes for the calls screens", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key")
  })

  it("signed out: /calls goes to login, the stream API answers 401", async () => {
    const page = await proxy(new NextRequest("https://kriya.test/calls/abc"))
    expect(page.status).toBe(307)
    expect(page.headers.get("location")).toContain("/login?next=%2Fcalls%2Fabc")
    const api = await proxy(
      new NextRequest("https://kriya.test/api/voice/tasks/x/stream")
    )
    expect(api.status).toBe(401)
    // Look-alikes aren't swept in
    expect((await proxy(new NextRequest("https://kriya.test/callsx"))).status).toBe(200)
  })
})
