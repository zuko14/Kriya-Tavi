import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// AS-DLV (EVALUATION_PLAN §3): 30 tasks across every delivery status, with
// fixture lags for the late re-check. Each row says what the model asked for
// and what happened to it, and the status the hand-written table expects. The
// table is the oracle: none of it is computed by deliveryOf. The model is
// scripted, the runner, approvals, verifier and re-check are real.
//
//   V  a draft the connector read back (verified)
//   U  an event whose read-back lagged (unverified)
//   F  an event whose read-back disagreed (failed)
//   D  an event the person declines
//   claim: the reply says "I've posted…", which no tool backs
//   lag:  what the re-check later finds for each U: v there, g gone, x can't read

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "", email: null }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock(
  "@/lib/connectors",
  async (original) => (await import("./mocks")).connectors(await original()) as never
)
vi.mock(
  "@/lib/models",
  async (original) => (await import("./mocks")).modelMock(await original()) as never
)

import { recheckDeliveries, type Readers } from "@/lib/delivery/recheck"

import {
  call,
  model,
  say,
  switches,
  world,
  type World,
} from "../../operator/golden/harness"
import { answerNext, delivery } from "./harness"
import { reset, seen } from "./mocks"

type Step = "V" | "U" | "F" | "D"
type Status = "delivered" | "partly" | "not_confirmed" | "nothing_to_deliver"
// [runs, claim?, lag?, expected]
const TABLE: [Step[], boolean, "v" | "g" | "x" | null, Status][] = [
  [["V"], false, null, "delivered"],
  [["U"], false, null, "not_confirmed"],
  [["F"], false, null, "not_confirmed"],
  [["D"], false, null, "nothing_to_deliver"],
  [[], false, null, "nothing_to_deliver"],
  [[], true, null, "not_confirmed"],
  [["V"], true, null, "partly"],
  [["U"], false, "v", "delivered"],
  [["U"], false, "g", "not_confirmed"],
  [["U"], false, "x", "not_confirmed"],
  [["F"], false, "v", "not_confirmed"],
  [["V", "V"], false, null, "delivered"],
  [["V", "U"], false, null, "partly"],
  [["V", "F"], false, null, "partly"],
  [["V", "D"], false, null, "delivered"],
  [["U", "U"], false, null, "not_confirmed"],
  [["U", "F"], false, null, "not_confirmed"],
  [["V", "U"], false, "v", "delivered"],
  [["V", "U"], false, "g", "partly"],
  [["V", "U"], false, "x", "partly"],
  [["U", "U"], false, "v", "delivered"],
  [["U", "D"], false, "v", "delivered"],
  [["U", "D"], false, null, "not_confirmed"],
  [["D", "D"], false, null, "nothing_to_deliver"],
  [["V", "V"], true, null, "partly"],
  [["V", "U"], true, "v", "partly"],
  [["U"], true, "v", "partly"],
  [["F", "F"], false, null, "not_confirmed"],
  [["V", "V", "V"], false, null, "delivered"],
  [["V", "V", "U"], false, null, "partly"],
]

const CLAIM = "I've posted the update to the team."
const NEXT = { KRIYA_NEXT_DELIVERY: "on", KRIYA_NEXT_RECHECK: "on" }
const nextSwitches = (on: boolean) => {
  for (const [key, value] of Object.entries(NEXT)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

let w: World
beforeEach(async () => {
  reset()
  w = await world()
  nextSwitches(true)
  await w.q(
    "update kriya.connections set scopes = scopes || '{https://www.googleapis.com/auth/calendar.events}' where provider = 'google'"
  )
})
afterEach(() => {
  nextSwitches(false)
  switches(false)
  model.script = () => say("Done.")
})

const event = (title: string) => ({
  title,
  start: "2026-10-30T10:00:00+05:30",
  end: "2026-10-30T11:00:00+05:30",
})
const input = (step: Step, i: number) =>
  step === "V"
    ? call(
        "gmail_draft",
        { to: [`p${i}@example.com`], subject: "Hi", body: "Hello" },
        `c${i}`
      )[0]
    : call("calendar_create_event", event(`${step}-${i}`), `c${i}`)[0]

// What the provider later says about each event, by the event's own id
const readers = (lag: "v" | "g" | "x"): Readers => ({
  calendar: async (_user, eventId) => {
    if (lag === "g") return { found: false }
    if (lag === "x") throw new Error("Google is down")
    const made = seen.events[Number(/^evt(\d+)/.exec(eventId)![1]) - 1]
    return {
      found: true,
      cancelled: false,
      title: made.title,
      attendees: [],
      startMs: Date.parse("2026-10-30T10:00:00+05:30"),
    }
  },
  githubIssue: async () => null,
  sheetsRange: async () => "gone",
})

describe("AS-DLV: 30 tasks, every delivery status", () => {
  it("has 30 rows and covers every status", () => {
    expect(TABLE).toHaveLength(30)
    expect(new Set(TABLE.map((row) => row[3]))).toEqual(
      new Set(["delivered", "partly", "not_confirmed", "nothing_to_deliver"])
    )
  })

  it.each(TABLE.map((row, i) => [i + 1, ...row] as const))(
    "#%i %j claim=%j lag=%j → %s",
    async (_n, steps, claim, lag, expected) => {
      model.script = (prompt, results) =>
        prompt.includes("GO") && results === 0 && steps.length > 0
          ? [...steps.map(input), call("x", {}, "x")[1]]
          : say(claim ? CLAIM : "Done.")
      await w.turn("GO: do these")
      for (const step of steps) await answerNext(w, step !== "D")

      if (lag) {
        await w.q(
          "update kriya.tool_executions set finished_at = now() - interval '10 minutes' where side_effect"
        )
        await recheckDeliveries(new Date(), { readers: readers(lag) })
      }
      const result = await delivery(w)
      expect(result?.status ?? "nothing_to_deliver").toBe(expected)
      // The reply's own words never decide it: a claim only ever lowers a status
      if (result && !claim && steps.every((s) => s === "V" || s === "D"))
        expect(result.open).toEqual([])
    },
    60_000
  )
})
