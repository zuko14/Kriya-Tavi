import { MockLanguageModelV4 } from "ai/test"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { setSetting } from "@/lib/config"
import { clock } from "@/lib/voice/schedule"
import { extractSpec } from "@/lib/voice/spec"
import { createDraft, requestConfirmation } from "@/lib/voice/tasks"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { seed } from "../db/voice-fixtures"

// D-19: a draft may carry a contact's number for Tavi to give, only with
// voice.shareContact on, only a valid mobile, never the person's own, and
// the confirmation card shows it. Numbers are synthetic.

let pg: TestDb
let user: string

const input = (extra = {}) => ({
  idempotencyKey: `k-${Math.random()}`,
  recipientLabel: "my CA",
  recipientPhone: "+91 98765 43210",
  purpose: "Give the CA Ravi's number",
  goal: {
    type: "deliver_message" as const,
    message: "Ravi will call you.",
    askForReply: false,
  },
  authority: {
    mayAcceptWithinAcceptable: false,
    mayProposeAlternatives: false,
    mayShareOwnerPhone: false as const,
    mayDiscuss: [],
  },
  mustNot: [],
  ...extra,
})
const specOf = async (taskId: string) =>
  (
    await pg.query<{ spec: { share?: unknown } }>(
      "select spec from kriya.voice_tasks where id = $1",
      [taskId]
    )
  ).rows[0].spec

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  vi.stubEnv("KRIYA_PHONE_HASH_KEY", "k".repeat(48))
  clock.now = () => new Date("2026-10-13T14:00:00+05:30")
  user = await createUser(pg)
  await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [user])
  await pg.query(
    `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
       max_voice_task_cost_micro_inr = 50000000 where id = 'free'`
  )
  await seed(pg, "voice_access", { user_id: user })
})

afterEach(async () => {
  await setSetting("voice.shareContact", null, user)
  vi.unstubAllEnvs()
})

describe("a number to give, in a draft", () => {
  it("is refused while voice.shareContact is off (the default)", async () => {
    const result = await createDraft(
      user,
      input({ share: { label: "Ravi", phone: "91234 56789" } })
    )
    expect(result).toMatchObject({
      ok: false,
      code: "invalid",
      fields: { share: expect.any(String) },
    })
    expect((await pg.query("select 1 from kriya.voice_tasks")).rows).toEqual([])
  })

  it("with the switch on: stored in +91 form and shown on the confirmation card", async () => {
    await setSetting("voice.shareContact", "on", user)
    const draft = await createDraft(
      user,
      input({ share: { label: "Ravi", phone: "091234 56789" } })
    )
    if (!draft.ok) throw new Error(draft.message)
    expect((await specOf(draft.taskId)).share).toEqual({
      label: "Ravi",
      phone: "+919123456789",
    })
    const ask = await requestConfirmation(user, draft.taskId)
    if (!ask.ok) throw new Error(ask.message)
    expect(ask.payload).toMatchObject({
      share: { label: "Ravi", phone: "+919123456789" },
    })
  })

  it("refuses an invalid number and the person's own number", async () => {
    await setSetting("voice.shareContact", "on", user)
    expect(
      await createDraft(user, input({ share: { label: "Ravi", phone: "112" } }))
    ).toMatchObject({
      ok: false,
      fields: { share: expect.any(String) },
    })
    await seed(pg, "voice_profiles", { user_id: user, owner_phone_e164: "+919000000001" })
    expect(
      await createDraft(user, input({ share: { label: "me", phone: "9000000001" } }))
    ).toMatchObject({ ok: false, fields: { share: "That's your own number." } })
  })

  it("a draft without one is unchanged: no share key at all", async () => {
    const draft = await createDraft(user, input())
    if (!draft.ok) throw new Error(draft.message)
    expect(await specOf(draft.taskId)).not.toHaveProperty("share")
    const ask = await requestConfirmation(user, draft.taskId)
    if (!ask.ok) throw new Error(ask.message)
    expect(ask.payload).not.toHaveProperty("share")
  })
})

describe("a number to give, from what the person typed", () => {
  const usage = {
    inputTokens: {
      total: 400,
      noCache: 400,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 80, text: 80, reasoning: undefined },
  }
  const model = (out: Record<string, unknown>) =>
    new MockLanguageModelV4({
      modelId: "m/spec",
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(out) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    })
  const OUT = {
    recipientLabel: "my CA",
    recipientName: null,
    recipientPhone: "98765 43210",
    purpose: "Give Ravi's number",
    goalType: "deliver_message",
    date: null,
    preferred: null,
    acceptable: [],
    message: "Ravi will call you",
    question: null,
    mayAcceptWithinAcceptable: false,
    mayProposeAlternatives: false,
    reportAt: null,
  }
  const TEXT = "Call my CA on 98765 43210 and give him Ravi's number, 91234 56789"
  const run = (out: Record<string, unknown>, text = TEXT) =>
    extractSpec({
      text,
      now: new Date("2026-10-20T12:00:00+05:30"),
      timezone: "Asia/Kolkata",
      model: model(out),
    })

  it("is taken only when the person typed it", async () => {
    expect(
      (await run({ ...OUT, shareLabel: "Ravi", sharePhone: "91234 56789" })).draft.share
    ).toEqual({
      label: "Ravi",
      phone: "91234 56789",
    })
    // A number the model made up, or the callee's own number, is dropped
    expect(
      (await run({ ...OUT, shareLabel: "Ravi", sharePhone: "99999 11111" })).draft.share
    ).toBeUndefined()
    expect(
      (await run({ ...OUT, shareLabel: "CA", sharePhone: "98765 43210" })).draft.share
    ).toBeUndefined()
  })

  it("a model that says nothing about it leaves the draft as before", async () => {
    expect((await run(OUT)).draft).not.toHaveProperty("share")
  })
})
