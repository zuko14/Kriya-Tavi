import { drizzle } from "drizzle-orm/pglite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { setSetting } from "@/lib/config"
import { Dialogue } from "@/lib/voice/dialogue"
import { LANGUAGES } from "@/lib/voice/languages"
import { clock } from "@/lib/voice/schedule"
import { createDraft, requestConfirmation } from "@/lib/voice/tasks"
import { specFor } from "@/scripts/voice-eval"

import { createTestDb, createUser } from "../db/harness"
import { seed } from "../db/voice-fixtures"
import { scriptedModel } from "./fair-model"

// D-21: Hindi and Telugu calls as language entries. One parser (times said
// in Hindi or Telugu become English words), the agreement guard's yes,
// maybe and no in each language, a switch only to a language that's on,
// with the AI disclosure said again in it.

const hi = LANGUAGES["hi-IN"]
const te = LANGUAGES["te-IN"]
// A Tuesday
const TODAY = "2026-10-20"

describe("times and dates said in Hindi", () => {
  it.each([
    ["kal shaam 4 baje", { date: "2026-10-21", time: "16:00" }],
    ["कल शाम 4 बजे", { date: "2026-10-21", time: "16:00" }],
    ["kal teen baje", { date: "2026-10-21", time: "15:00" }],
    ["parson subah das baje", { date: "2026-10-22", time: "10:00" }],
    ["शुक्रवार को दोपहर 3 बजे", { date: "2026-10-23", time: "15:00" }],
    ["shukravar saade teen baje", { date: "2026-10-23", time: "15:30" }],
    ["aaj shaam sawa paanch baje", { date: "2026-10-20", time: "17:15" }],
    ["kal paune chaar baje", { date: "2026-10-21", time: "15:45" }],
    ["4 baje shaam ko", { date: null, time: "16:00" }],
    ["कल 11 बजे", { date: "2026-10-21", time: "11:00" }],
  ])("%s", (text, want) => {
    expect(hi.normalize(text, TODAY)).toMatchObject(want)
  })

  it("a range is a window to narrow down", () => {
    expect(hi.normalize("3 se 5 ke beech", TODAY)).toMatchObject({
      window: { from: "15:00", to: "17:00" },
      ask: "time",
    })
  })
})

describe("times and dates said in Telugu", () => {
  it.each([
    ["repu saayantram naalugu gantalaku", { date: "2026-10-21", time: "16:00" }],
    ["రేపు సాయంత్రం 4 గంటలకు", { date: "2026-10-21", time: "16:00" }],
    ["repu madhyahnam moodu gantalaku", { date: "2026-10-21", time: "15:00" }],
    ["ellundi udayam padi gantalaku", { date: "2026-10-22", time: "10:00" }],
    ["శుక్రవారం మధ్యాహ్నం 3 గంటలకు", { date: "2026-10-23", time: "15:00" }],
    ["ivala 5 gantalaku", { date: "2026-10-20", time: "17:00" }],
  ])("%s", (text, want) => {
    expect(te.normalize(text, TODAY)).toMatchObject(want)
  })
})

describe("the agreement guard in Hindi and Telugu", () => {
  it.each([
    ["Haan, theek hai", true],
    ["जी हाँ, ठीक है", true],
    ["Bilkul, chalega", true],
    ["Haan, works for me", true],
    ["Shayad, dekhta hoon", false],
    ["Nahi, kal nahi ho payega", false],
    ["पता नहीं", false],
    ["Haan, but let me check", false],
  ])("hi: %s → %s", (text, yes) => {
    expect(hi.is.affirmative(text)).toBe(yes)
  })

  it.each([
    ["Avunu, sare", true],
    ["అవును, కుదురుతుంది", true],
    ["Alage andi", true],
    ["Emo, chustanu", false],
    ["Ledu, kudaradu", false],
    ["లేదు", false],
  ])("te: %s → %s", (text, yes) => {
    expect(te.is.affirmative(text)).toBe(yes)
  })

  it("English yes and no are still read on a Hindi call (Hinglish)", () => {
    expect(hi.is.affirmative("Yes, that works")).toBe(true)
    expect(hi.is.affirmative("No, that doesn't work")).toBe(false)
  })
})

describe("speaking Hindi and Telugu", () => {
  it("reads a time back in the call's language", () => {
    expect(hi.speak("2026-10-21", "15:00")).toBe("बुधवार 21 तारीख को दोपहर 3 बजे")
    expect(te.speak("2026-10-21", "16:30")).toBe("బుధవారం, 21వ తేదీ సాయంత్రం 4:30 గంటలకు")
  })

  it("the AI disclosure exists in each language and names the owner", () => {
    for (const lang of [hi, te]) expect(lang.disclosure("Asha")).toContain("Asha")
    expect(hi.disclosure("Asha")).toContain("AI सहायक")
    expect(te.disclosure("Asha")).toContain("AI అసిస్టెంట్")
  })
})

describe("a Hindi call and a switch mid-call", () => {
  const talk = async (d: Dialogue, lines: string[]) => {
    const said = [d.opening()]
    for (const line of lines) {
      d.played(said.at(-1)!.seq, true)
      const reply = await d.hear(line)
      if (reply) said.push(reply)
    }
    return said.map((r) => r.text)
  }

  it("a Hindi call: disclosure, read-back and agreement in Hindi; the model is told", async () => {
    const model = scriptedModel()
    const d = new Dialogue({
      spec: specFor({ id: "hi", callee: [], spec: { language: "hi-IN" } }),
      model,
      today: TODAY,
      maxCallSeconds: 300,
      now: () => 0,
    })
    const said = await talk(d, ["हाँ, बोलिए", "जी हाँ", "कल शाम 4 बजे?", "हाँ, ठीक है"])
    expect(said[0]).toBe(hi.disclosure("Asha"))
    expect(said[2]).toBe(
      "Asha आपसे बुधवार 21 तारीख को दोपहर 3 बजे मिलना चाहते हैं। क्या यह आपके लिए ठीक रहेगा?"
    )
    expect(said[3]).toBe("तो बुधवार 21 तारीख को शाम 4 बजे, ठीक है?")
    expect(d.notes.agreed).toMatchObject([{ date: "2026-10-21", time: "16:00" }])
    expect(model.doGenerateCalls.length).toBeGreaterThan(0)
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain(
      "The callee is speaking Hindi"
    )
  })

  it("switches to a language that's on and says the disclosure again first", async () => {
    const d = new Dialogue({
      spec: specFor({ id: "switch", callee: [] }),
      model: scriptedModel(),
      today: TODAY,
      maxCallSeconds: 300,
      now: () => 0,
      languages: ["en-IN", "te-IN"],
    })
    const said = await talk(d, ["Hello?", "Telugu lo matladandi", "Avunu", "Avunu, sare"])
    expect(said[2]).toBe(te.disclosure("Asha"))
    expect(d.language).toBe("te-IN")
    expect(d.notes.flags).toContain("switched to Telugu")
    expect(said[3]).toBe("నేను Asha గారి CA తో మాట్లాడుతున్నానా?")
  })

  it("an English call never gets a language line in its prompt", async () => {
    const model = scriptedModel()
    const d = new Dialogue({
      spec: specFor({ id: "en", callee: [] }),
      model,
      today: TODAY,
      maxCallSeconds: 300,
      now: () => 0,
    })
    await talk(d, ["Hello?", "Yes.", "Can we do 4 pm?"])
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).not.toContain(
      "The callee is speaking"
    )
  })
})

describe("a draft in Hindi", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is refused until voice.languages has it, then carries the Hindi opening", async () => {
    const pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    vi.stubEnv("KRIYA_PHONE_HASH_KEY", "k".repeat(48))
    clock.now = () => new Date("2026-10-13T14:00:00+05:30")
    const user = await createUser(pg)
    await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [
      user,
    ])
    await pg.query(
      `update kriya.plans set voice_enabled = true, max_outreach_calls_per_day = 5,
         max_voice_task_cost_micro_inr = 50000000 where id = 'free'`
    )
    await seed(pg, "voice_access", { user_id: user })
    const input = {
      idempotencyKey: `k-${Math.random()}`,
      recipientLabel: "my CA",
      recipientPhone: "+91 98765 43210",
      purpose: "Ask about tomorrow",
      language: "hi-IN" as const,
      goal: { type: "ask_question" as const, question: "Kal aap free hain?" },
      authority: {
        mayAcceptWithinAcceptable: false,
        mayProposeAlternatives: false,
        mayShareOwnerPhone: false as const,
        mayDiscuss: [],
      },
      mustNot: [],
    }
    expect(await createDraft(user, input)).toMatchObject({
      ok: false,
      fields: { language: expect.any(String) },
    })
    await setSetting("voice.languages", "en-IN,hi-IN", user)
    const draft = await createDraft(user, { ...input, idempotencyKey: "k-2" })
    if (!draft.ok) throw new Error(draft.message)
    const ask = await requestConfirmation(user, draft.taskId)
    if (!ask.ok) throw new Error(ask.message)
    expect(ask.payload).toMatchObject({
      language: "hi-IN",
      disclosure: hi.disclosure("Asha"),
    })
    await setSetting("voice.languages", null, user)
    clock.now = () => new Date()
  })
})
