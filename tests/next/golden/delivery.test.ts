import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// N11 golden scenarios for proof after the fact (NSC-17, 18, 20): a run whose
// read-back couldn't be confirmed, the late re-check that settles it, and the
// Inbox's list of what was done with statuses computed by code. Scripted
// model, the real runner and worker re-check, PGlite; the provider's answer to
// the re-check is a fixture reader.

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
import { deliveryOf, deliveryView } from "@/lib/delivery/status"
import { deliveryForTasks, recentEpisodes } from "@/queries/episodes"

import {
  call,
  model,
  say,
  switches,
  world,
  type World,
} from "../../operator/golden/harness"
import { answerAll, delivery } from "./harness"
import { behave, reset, seen } from "./mocks"

const NEXT = {
  KRIYA_NEXT_DELIVERY: "on",
  KRIYA_NEXT_RECHECK: "on",
}
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

const EVENT = {
  title: "Maths exam",
  start: "2026-10-30T10:00:00+05:30",
  end: "2026-10-30T11:00:00+05:30",
}
const DRAFT = { to: ["ravi@example.com"], subject: "Hi", body: "Hello" }

// A draft (read back fine) and an event (Google's read right after said "not
// found": unverified), in one reply
const run = async () => {
  behave.calendar = "unverified"
  model.script = (prompt, results) =>
    prompt.includes("BOTH") && results === 0
      ? [
          call("gmail_draft", DRAFT, "g1")[0],
          call("calendar_create_event", EVENT, "e1")[0],
          call("x", {}, "x")[1],
        ]
      : say("Saved the draft and added the exam.")
  await w.turn("BOTH: draft the note and add the exam")
  await answerAll(w)
}

// Minutes after it finished, as the worker's scheduler would find it
const aged = (minutes: number) =>
  w.q(
    "update kriya.tool_executions set finished_at = now() - make_interval(mins => $1) where side_effect",
    [minutes]
  )

const reader = (found: Awaited<ReturnType<Readers["calendar"]>>): Readers => ({
  calendar: async () => found,
  githubIssue: async () => null,
  sheetsRange: async () => "gone",
})
const there = {
  found: true as const,
  cancelled: false,
  title: EVENT.title,
  attendees: [],
  startMs: Date.parse(EVENT.start),
}

describe("NG-17 NSC-17: the first read-back lagged", () => {
  it("partly at first; a re-check 2–30 minutes later turns it delivered, and says when", async () => {
    await run()
    const first = (await delivery(w))!
    expect(first.status).toBe("partly")
    expect(first.episode.done.map((d) => d.tool)).toEqual(["gmail_draft"])
    expect(first.open.map((o) => o.claim)).toEqual([expect.stringContaining("calendar")])

    // Too soon for the re-check: nothing happens
    await aged(1)
    expect(await recheckDeliveries(new Date(), { readers: reader(there) })).toMatchObject(
      {
        candidates: 0,
      }
    )
    await aged(10)
    expect(await recheckDeliveries(new Date(), { readers: reader(there) })).toMatchObject(
      {
        checked: 1,
        verified: 1,
      }
    )
    const after = (await delivery(w))!
    expect(after.status).toBe("delivered")
    expect(after.laterVerified).toHaveLength(1)
    // The record itself is as it was: only a new row was added
    expect(after.episode).toEqual(first.episode)
    expect(await w.q("select kind, status from kriya.delivery_checks")).toEqual([
      { kind: "recheck", status: "verified" },
    ])
    // One re-check per run: another tick adds nothing
    expect(await recheckDeliveries(new Date(), { readers: reader(there) })).toMatchObject(
      {
        candidates: 0,
      }
    )
    expect(seen.events).toHaveLength(1)
  })

  it("a re-check that can't read leaves it open, and the card is the same as before", async () => {
    await run()
    await aged(10)
    const broken: Readers = {
      ...reader(there),
      calendar: async () => {
        throw new Error("Google is down")
      },
    }
    expect(await recheckDeliveries(new Date(), { readers: broken })).toMatchObject({
      checked: 1,
      unverified: 1,
    })
    expect((await delivery(w))!.status).toBe("partly")
  })
})

describe("NG-18 NSC-18: the person deletes the event before the re-check", () => {
  it("it was made and is no longer there: never delivered, and the view says so", async () => {
    await run()
    await aged(10)
    expect(
      await recheckDeliveries(new Date(), { readers: reader({ found: false }) })
    ).toMatchObject({ checked: 1, gone: 1 })
    const result = (await delivery(w))!
    expect(result.status).toBe("partly")
    expect(result.laterVerified).toEqual([])
    expect(result.gone).toHaveLength(1)
    const [row] = await w.q<{ task_id: string }>("select task_id from kriya.episodes")
    const checks = await deliveryForTasks(w.user, [row.task_id])
    const view = deliveryView(result.episode as never, checks)
    expect(view.gone).toEqual(result.gone)
    expect(view.status).toBe("partly")
  })
})

describe("NG-20 NSC-20: 'What did you do for me last week?'", () => {
  it("the list is the person's records with statuses equal to deliveryOf; the agent has no tool to recall it", async () => {
    // One delivered task, one not-confirmed one
    behave.calendar = "verified"
    model.script = (prompt, results) =>
      prompt.includes("ONE") && results === 0
        ? call("gmail_draft", DRAFT, "g1")
        : say("Saved the draft.")
    await w.turn("ONE: draft the note")
    await answerAll(w)
    model.script = () => say("I've posted the update to the team.")
    await w.turn("TWO: tell the team")

    const records = await recentEpisodes(w.user)
    expect(records).toHaveLength(2)
    const checks = await deliveryForTasks(
      w.user,
      records.flatMap((r) => (r.taskId ? [r.taskId] : []))
    )
    const statuses = records.map(
      (r) =>
        deliveryOf(
          r,
          checks.filter((c) => c.taskId === r.taskId)
        ).status
    )
    expect(statuses.sort()).toEqual(["delivered", "not_confirmed"])

    // Asked about last week, the agent has no way to recall it, so it points to the Inbox
    model.script = () => say("You can see everything in your Inbox under What I did.")
    await w.turn("What did you do for me last week?")
    const belt = seen.tools.at(-1)!
    expect(belt.filter((name) => /episode|what_i_did|history|recall/.test(name))).toEqual(
      []
    )
    const latest = (
      await w.q<{ unconfirmed: unknown[] }>(
        "select unconfirmed from kriya.episodes order by seq desc limit 1"
      )
    )[0]
    // The pointer to the Inbox claims nothing
    expect(await w.q("select 1 from kriya.episodes")).toHaveLength(2)
    expect(latest.unconfirmed).toBeDefined()
  })
})
