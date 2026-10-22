import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { calendarCreate, gmailDraft } from "@/lib/connectors"

import { connectedUser, serve } from "../connectors/fixtures"

// OF-13 (owner-approved 2026-10-22): a saved draft and a created event are
// read back from Google, so "What I did" can confirm them and a job's
// tool_verified criterion can be met. Fixtures only; no real Google call.

const GMAIL = "https://www.googleapis.com/gmail/v1/users/me/drafts"
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
const header = (name: string, value: string) => ({ name, value })

let userId: string
beforeAll(async () => {
  ;({ userId } = await connectedUser(["google"]))
})
afterEach(() => vi.unstubAllGlobals())

describe("gmail_draft read-back", () => {
  const draft = {
    to: ["A@example.com", "b@example.com"],
    subject: "Invoice 12",
    body: "Hi",
  }
  const saved = (to: string, subject = "Invoice 12") => [
    { method: "POST", url: new RegExp(`^${esc(GMAIL)}$`), body: { id: "d1" } },
    {
      url: new RegExp(`^${esc(GMAIL)}/d1\\?`),
      body: {
        id: "d1",
        message: { payload: { headers: [header("To", to), header("Subject", subject)] } },
      },
    },
  ]

  it("verified when the draft exists with exactly those recipients", async () => {
    const calls = serve(saved("a@example.com, Bee <b@example.com>"))
    const result = await gmailDraft(userId, draft)
    expect(result.draftId).toBe("d1")
    expect(result.verification).toMatchObject({
      status: "verified",
      method: "api_readback",
      evidence: expect.arrayContaining([{ kind: "provider_id", value: "d1" }]),
    })
    // The check reads only headers, never the body
    expect(calls[1].url).toContain("format=metadata")
    expect(result.verification.note).not.toMatch(/@/)
  })

  it("failed when Google holds other recipients", async () => {
    serve(saved("a@example.com"))
    expect((await gmailDraft(userId, draft)).verification.status).toBe("failed")
  })

  it("failed when the draft can't be read back", async () => {
    serve([
      { method: "POST", url: new RegExp(`^${esc(GMAIL)}$`), body: { id: "d1" } },
      { url: new RegExp(`^${esc(GMAIL)}/d1\\?`), status: 404, body: { error: {} } },
    ])
    const result = await gmailDraft(userId, draft)
    expect(result.draftId).toBe("d1")
    expect(result.verification.status).toBe("failed")
  })
})

describe("calendar_create_event read-back", () => {
  const input = {
    title: "Review",
    start: "2026-11-01T10:00:00",
    end: "2026-11-01T11:00:00",
    timeZone: "Asia/Kolkata",
    attendees: ["a@example.com"],
  }
  const created = { id: "e1", summary: "Review", attendees: [{ email: "a@example.com" }] }

  it("verified when the event is there with that title and those guests", async () => {
    serve([
      { method: "POST", url: new RegExp(`^${esc(CALENDAR)}\\?`), body: created },
      {
        url: new RegExp(`^${esc(CALENDAR)}/e1$`),
        body: { ...created, status: "confirmed" },
      },
    ])
    const result = await calendarCreate(userId, input)
    expect(result.id).toBe("e1")
    expect(result.verification).toMatchObject({
      status: "verified",
      method: "api_readback",
    })
  })

  it("failed when the event is cancelled or its guests differ", async () => {
    serve([
      { method: "POST", url: new RegExp(`^${esc(CALENDAR)}\\?`), body: created },
      {
        url: new RegExp(`^${esc(CALENDAR)}/e1$`),
        body: { ...created, status: "cancelled" },
      },
    ])
    expect((await calendarCreate(userId, input)).verification.status).toBe("failed")
    serve([
      { method: "POST", url: new RegExp(`^${esc(CALENDAR)}\\?`), body: created },
      {
        url: new RegExp(`^${esc(CALENDAR)}/e1$`),
        body: { ...created, attendees: [{ email: "x@example.com" }] },
      },
    ])
    expect((await calendarCreate(userId, input)).verification.status).toBe("failed")
  })
})
