import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// N11 golden scenarios on the person's own accounts (NSC-02, 05, 07, 08, 10,
// 11, 21; EVALUATION_PLAN §2): a scripted model, the real runner, approvals and
// verifier, PGlite, and the connectors faked at module level. Each asserts the
// tool runs, the approvals and their exact input, the record, and the delivery
// status code computed from them, with every next.* switch on.

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "", email: null }),
}))
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
  "@/lib/connectors/sheets",
  async (original) => (await import("./mocks")).sheetsConnector(await original()) as never
)
vi.mock(
  "@/lib/connectors/github",
  async (original) => (await import("./mocks")).githubConnector(await original()) as never
)
vi.mock(
  "@/lib/web",
  async (original) => (await import("./mocks")).webMock(await original()) as never
)
vi.mock(
  "@/lib/models",
  async (original) => (await import("./mocks")).modelMock(await original()) as never
)

import {
  call,
  model,
  say,
  switches,
  world,
  type World,
} from "../../operator/golden/harness"
import { behave, reset, seen } from "./mocks"
import { setBrowserProviderForTests } from "@/lib/browser/session"
import { gstinProblems } from "@/lib/gst"
import { FixtureBrowser } from "../../agent/fixture-browser"
import { answerAll, delivery, runsOf } from "./harness"

const NEXT = {
  KRIYA_NEXT_DELIVERY: "on",
  KRIYA_NEXT_RECHECK: "on",
  KRIYA_NEXT_RELIABILITY: "on",
  KRIYA_NEXT_SKILLS_V2: "on",
  KRIYA_AGENTS_SKILL_LIBRARY: "on",
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
  // The agent has the bills and calendar skills turned on (a role would too)
  await w.q(
    `update kriya.agents set skills = '{"on":["gst-invoices","calendar-operations"],"auto":true}'`
  )
  // The person also connected Calendar and GitHub
  await w.q(
    "update kriya.connections set scopes = scopes || '{https://www.googleapis.com/auth/calendar.events}' where provider = 'google'"
  )
  await w.q(
    "insert into kriya.connections (id, user_id, provider, scopes, access_token) values ('c2', $1, 'github', '{}', 'sealed')",
    [w.user]
  )
})
afterEach(() => {
  nextSwitches(false)
  switches(false)
  model.script = () => say("Done.")
})

// One tool call on the first step, then the written answer
const once = (marker: string, tool: string, input: unknown, answer: string) => {
  model.script = (run, results) =>
    run.includes(marker) && results === 0 ? call(tool, input, "c1") : say(answer)
}

describe("NG-05 NSC-05: exam dates onto the calendar", () => {
  const event = {
    title: "Maths exam",
    start: "2026-10-30T10:00:00",
    end: "2026-10-30T11:00:00",
  }

  it("the event waits for the person, runs once on approval, is read back, and the task is delivered", async () => {
    once("EXAMS", "calendar_create_event", event, "Added your Maths exam on 30 October.")
    await w.turn("EXAMS: put my exam on my calendar")
    // Nothing created before the person says yes; the ask carries the exact input
    expect(seen.events).toEqual([])
    const [ask] = await w.q<{ tool_name: string; preview: { input: { title: string } } }>(
      "select tool_name, preview from kriya.approvals where status = 'pending'"
    )
    expect(ask.tool_name).toBe("calendar_create_event")
    expect(ask.preview.input.title).toBe("Maths exam")

    expect(await answerAll(w)).toBe(1)
    expect(seen.events).toHaveLength(1)
    const runs = await runsOf(w, "calendar_create_event")
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      side_effect: true,
      verification: expect.objectContaining({ status: "verified" }),
    })
    const result = await delivery(w)
    expect(result).toMatchObject({ status: "delivered", checks: [] })
    expect(result!.episode.done.map((d) => d.tool)).toEqual(["calendar_create_event"])
  })

  it("declined: nothing is created and nothing is claimed", async () => {
    once("EXAMS", "calendar_create_event", event, "I didn't add it.")
    await w.turn("EXAMS: put my exam on my calendar")
    await answerAll(w, false)
    expect(seen.events).toEqual([])
    expect(await runsOf(w, "calendar_create_event")).toEqual([])
    // No run and no claim: no record (a plain answer), so nothing is "delivered"
    expect(await delivery(w)).toBeNull()
  })
})

describe("NG-07 NSC-07: a review comment as the person", () => {
  it("R4: the exact text is approved, the comment is read back, and the run is undoable-recorded", async () => {
    once(
      "PR42",
      "github_comment",
      { repo: "octo-org/kriya-demo", number: 42, body: "LGTM, two nits inline." },
      "Commented on PR 42."
    )
    await w.turn("PR42: comment my review")
    expect(seen.comments).toEqual([])
    const [ask] = await w.q<{ risk_class: string; preview: { input: { body: string } } }>(
      "select risk_class, preview from kriya.approvals where status = 'pending'"
    )
    expect(ask.risk_class).toBe("R4")
    expect(ask.preview.input.body).toBe("LGTM, two nits inline.")
    await answerAll(w)
    expect(seen.comments).toEqual([
      { repo: "octo-org/kriya-demo", number: 42, body: "LGTM, two nits inline." },
    ])
    const [run] = await runsOf(w, "github_comment")
    expect(run).toMatchObject({ status: "succeeded", side_effect: true })
    expect((await delivery(w))!.status).toBe("delivered")
  })
})

describe("NG-08 NSC-08: a sheet made from the person's numbers", () => {
  it("the new sheet is approved, created and read back; delivered", async () => {
    once(
      "POSTS",
      "sheets_create",
      {
        title: "Last week's posts",
        tabs: [{ name: "Posts", columns: [{ name: "Post", type: "text" }] }],
      },
      "Made the sheet."
    )
    await w.turn("POSTS: make a sheet")
    await answerAll(w)
    expect(seen.sheets.map((s) => s.title)).toEqual(["Last week's posts"])
    expect((await delivery(w))!.status).toBe("delivered")
  })
})

describe("NG-10 NSC-10: pay the electricity bill", () => {
  it("no tool exists for it; the reply makes no payment claim; nothing to deliver", async () => {
    model.script = () =>
      say("I can't pay bills. Please pay it yourself; I'll remind you of the due date.")
    await w.turn("Pay the electricity bill")
    expect(await w.q("select 1 from kriya.tool_executions")).toEqual([])
    // A plain answer leaves no record to judge: nothing claimed, nothing owed
    expect(await delivery(w)).toBeNull()
    expect(await w.q("select 1 from kriya.episodes")).toEqual([])
  })
})

describe("NG-11 NSC-11: send the payment link to Ravi", () => {
  it("only a draft is possible: it asks, saves a draft, and never says it sent", async () => {
    once(
      "LINK",
      "gmail_draft",
      { to: ["ravi@example.com"], subject: "Payment link", body: "Here is the link." },
      "I saved a draft for you to send."
    )
    await w.turn("LINK: send the payment link to Ravi")
    // There is no payment or send tool on the belt at all
    const belt = seen.tools[0]
    expect(belt.filter((name) => /pay|send/.test(name))).toEqual([])
    await answerAll(w)
    expect(seen.drafts.map((d) => d.to)).toEqual([["ravi@example.com"]])
    expect((await delivery(w))!.status).toBe("delivered")
  })
})

describe("NG-21 NSC-21: the reply says it did things no tool did", () => {
  it("claims no tool run backs are marked, and the status is not_confirmed", async () => {
    model.script = () =>
      say("I've posted the comment on PR 7. I've added the deadline to your calendar.")
    await w.turn("File the login bug")
    const result = (await delivery(w))!
    expect(result.status).toBe("not_confirmed")
    expect(result.episode.unconfirmed).toHaveLength(2)
    expect(result.episode.unconfirmed.every((u) => !u.executionId)).toBe(true)
    expect(result.episode.done).toEqual([])
  })

  it("an action the tool failed on isn't delivered either", async () => {
    behave.calendar = "failed"
    once(
      "FAIL",
      "calendar_create_event",
      { title: "Dentist", start: "2026-10-30T10:00:00", end: "2026-10-30T11:00:00" },
      "Booked the dentist."
    )
    await w.turn("FAIL: book the dentist")
    await answerAll(w)
    const result = (await delivery(w))!
    expect(result.status).not.toBe("delivered")
    expect(result.episode.done).toEqual([])
  })
})

const active = async () =>
  (
    await w.q<{ skill_id: string }>(
      "select skill_id from kriya.skill_activations where status = 'active' order by skill_id"
    )
  ).map((r) => r.skill_id)

describe("NG-12 NSC-12: Hindi: put all my bills in the sheet", () => {
  const ask = "मेरे सारे बिल शीट में डाल दो"
  const sheet = {
    spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvW",
    range: "Bills!A1",
    rows: [["Vendor", "₹1,180"]],
  }

  it("with skills v2 on the bill skill loads from the Hindi words; the append is approved, read back, delivered", async () => {
    model.script = (run, results) =>
      results === 0 ? call("sheets_append", sheet, "c1") : say("Done.")
    await w.turn(ask)
    expect(await active()).toContain("gst-invoices")
    expect(seen.prompts[0]).toContain("Invoices, ledger and GST")
    await answerAll(w)
    expect(seen.appends).toEqual([sheet])
    expect((await delivery(w))!.status).toBe("delivered")
  })

  it("with it off nothing else changes: the same belt, no v2 skill, and the same task still works", async () => {
    nextSwitches(false)
    process.env.KRIYA_AGENTS_SKILL_LIBRARY = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    model.script = (run, results) =>
      results === 0 ? call("sheets_append", sheet, "c1") : say("Done.")
    await w.turn(ask)
    expect(await active()).not.toContain("gst-invoices")
    expect(seen.prompts[0]).not.toContain("Invoices, ledger and GST")
    await answerAll(w)
    expect(seen.appends).toEqual([sheet])
  })
})

describe("NG-13 NSC-13: Telugu and romanised requests for a calendar event", () => {
  it.each([
    ["Telugu", "రేపటి మీటింగ్ క్యాలెండర్‌లో పెట్టు"],
    ["romanised", "kal meeting hai, calendar mein daalo"],
  ])(
    "%s: calendar-operations loads, the event is approved and read back",
    async (_n, ask) => {
      model.script = (run, results) =>
        results === 0
          ? call(
              "calendar_create_event",
              {
                title: "Meeting",
                start: "2026-10-26T10:00:00",
                end: "2026-10-26T11:00:00",
              },
              "c1"
            )
          : say("Done.")
      await w.turn(ask)
      expect(await active()).toContain("calendar-operations")
      await answerAll(w)
      expect(seen.events.map((e) => e.title)).toEqual(["Meeting"])
      expect((await delivery(w))!.status).toBe("delivered")
    }
  )
})

describe("NG-02 NSC-02: today's bills into the stock sheet, GST total by code", () => {
  it("the ledger totals are computed in code, the append is approved and read back", async () => {
    const gstin = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
      .map((c) => `29ABCDE1234F1Z${c}`)
      .find((g) => gstinProblems(g).length === 0)!
    const bill = (doc: string, total: number) => ({
      date: "2026-10-05",
      counterparty: "Vendor",
      gstin,
      placeOfSupply: "29",
      documentNo: doc,
      lines: [{ description: "Rice", amountPaise: 10000, taxRateBps: 1800 }],
      taxablePaise: 10000,
      cgstPaise: 900,
      sgstPaise: 900,
      totalPaise: total,
    })
    const rows = [
      ["B1", "11800"],
      ["B2", "99999"],
    ]
    model.script = (run, results) =>
      results === 0
        ? call(
            "ledger_draft_entry",
            { entries: [bill("B1", 11800), bill("B2", 99999)] },
            "l1"
          )
        : results === 1
          ? call(
              "sheets_append",
              { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvW", range: "Stock!A1", rows },
              "a1"
            )
          : say("Added both bills.")
    await w.turn("Add today's bills to the stock sheet and tell me the GST total")
    // Code, not the model, decides which bill doesn't add up
    expect(
      await w.q(
        "select document_no, status from kriya.ledger_entries order by document_no"
      )
    ).toEqual([
      { document_no: "B1", status: "draft" },
      { document_no: "B2", status: "needs_review" },
    ])
    await answerAll(w)
    expect(seen.appends.map((a) => a.range)).toEqual(["Stock!A1"])
    const result = (await delivery(w))!
    expect(result.status).toBe("delivered")
    expect(result.episode.done.map((d) => d.tool)).toEqual(["sheets_append"])
  })
})

describe("NG-06 NSC-06: fill my scholarship form on the portal", () => {
  const DEEP = "https://scholarships.example.test/apply"
  const fields = [
    { label: "Full name", text: "Aarav Mehta" },
    { label: "Statement", text: "I want to study electronics." },
  ]
  let browser: FixtureBrowser

  beforeEach(async () => {
    process.env.KRIYA_AGENTS_BROWSER = "on"
    process.env.KRIYA_AGENTS_KITS = "on"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    await w.q("update kriya.plans set browser_minutes = 10")
    browser = new FixtureBrowser()
    // Each task opens its own session, with its own id
    browser.open = async () => ({ sessionId: randomUUID() })
    setBrowserProviderForTests(browser)
  })
  afterEach(() => {
    delete process.env.KRIYA_AGENTS_BROWSER
    delete process.env.KRIYA_AGENTS_KITS
    setBrowserProviderForTests(null)
  })

  it("Kriya prepares the text and presses nothing; it is verified only when the page shows it", async () => {
    model.script = (run, results) =>
      run.includes("SCHOLAR") && results === 0
        ? call(
            "kit_prepare",
            { title: "Scholarship form", deepLink: DEEP, fields, verifyUrl: DEEP },
            "k1"
          )
        : say("Here is your kit: copy each field into the form yourself, then tell me.")
    await w.turn("SCHOLAR: fill my scholarship form on the portal")

    // Nothing on the belt can type, press Save or Submit, or enter a password
    expect(seen.tools[0].filter((n) => /type|fill|submit|password|otp/.test(n))).toEqual(
      []
    )
    // The portal was only read, never driven
    expect(browser.calls.every((c) => c.startsWith("open"))).toBe(true)
    const [kit] = await w.q<{ id: string; status: string }>(
      "select id, status from kriya.kits"
    )
    expect(kit.status).toBe("ready")

    // The person applies it themselves and says so; the page doesn't show it yet
    model.script = (run, results) =>
      run.includes("APPLIED") && results === 0
        ? call("kit_check", { kitId: kit.id }, "k2")
        : say("Not yet: the page doesn't show your answers.")
    await w.turn("APPLIED: I've filled it in")
    expect(
      (await w.q<{ status: string }>("select status from kriya.kits"))[0].status
    ).not.toBe("verified")

    // Once the public page shows the text, Kriya's own check says verified
    browser.pages[DEEP] = {
      title: "Aarav Mehta. I want to study electronics.",
      elements: [],
    }
    model.script = (run, results) =>
      run.includes("AGAIN") && results === 0
        ? call("kit_check", { kitId: kit.id }, "k3")
        : say("Your page shows both answers.")
    await w.turn("AGAIN: check once more")

    expect(
      (await w.q<{ status: string }>("select status from kriya.kits"))[0].status
    ).toBe("verified")
    // Never "submitted" by Kriya: no side-effect run exists at all
    expect(await w.q("select 1 from kriya.tool_executions where side_effect")).toEqual([])
  })
})
