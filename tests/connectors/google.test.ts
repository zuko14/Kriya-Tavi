import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import {
  authorizeUrl,
  calendarDelete,
  gmailDeleteDraft,
  GOOGLE_EXTRA_SERVICES,
  googleServices,
  GOOGLE_SERVICES,
  isGoogleService,
} from "@/lib/connectors"
import { sameCells, sheetsAppend, sheetsUpdate } from "@/lib/connectors/sheets"
import { youtubeStats } from "@/lib/connectors/youtube"

import { connectedUser, serve } from "./fixtures"

// Sheets and YouTube are extra scopes on the Google connection (AF-15);
// calendar and Gmail get their Undo compensations (K3).

const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/`
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

let userId: string
beforeAll(async () => {
  ;({ userId } = await connectedUser(["google"]))
})
afterEach(() => vi.unstubAllGlobals())

describe("google services", () => {
  it("Sheets and YouTube are never in the default request", () => {
    // The connect route asks for every GOOGLE_SERVICES key when nothing is picked
    const defaults = Object.keys(GOOGLE_SERVICES).filter(isGoogleService)
    expect(defaults).toEqual(["calendar", "gmail", "drive"])
    process.env.GOOGLE_CLIENT_ID = "test-client"
    process.env.GOOGLE_CLIENT_SECRET = "test-secret"
    const url = new URL(
      authorizeUrl("google", {
        state: "s",
        redirectUri: "https://kriya.test/cb",
        services: defaults,
      })
    )
    expect(url.searchParams.get("scope")).not.toContain("spreadsheets")
    expect(url.searchParams.get("scope")).not.toContain("youtube")
    const picked = new URL(
      authorizeUrl("google", {
        state: "s",
        redirectUri: "https://kriya.test/cb",
        services: ["sheets"],
      })
    )
    expect(picked.searchParams.get("scope")).toContain(
      GOOGLE_EXTRA_SERVICES.sheets.scopes[0]
    )
  })

  it("switches Sheets on only when its scope was granted", () => {
    expect(googleServices([...GOOGLE_EXTRA_SERVICES.sheets.scopes])).toEqual(["sheets"])
    expect(googleServices([...GOOGLE_SERVICES.drive.scopes])).toEqual(["drive"])
  })
})

describe("sheets", () => {
  it("appends RAW, never as formulas, and verifies by reading the range back", async () => {
    const rows = [['=IMPORTXML("https://x.example")', "₹1,200"]]
    const calls = serve([
      {
        method: "POST",
        url: new RegExp(`^${esc(SHEETS)}Sheet1:append`),
        body: { updates: { updatedRange: "Sheet1!A5:B5", updatedRows: 1 } },
      },
      {
        url: new RegExp(
          `^${esc(SHEETS)}${esc(encodeURIComponent("Sheet1!A5:B5"))}\\?valueRenderOption=UNFORMATTED_VALUE$`
        ),
        body: { range: "Sheet1!A5:B5", values: rows },
      },
    ])
    const result = await sheetsAppend(userId, {
      spreadsheetId: SHEET_ID,
      range: "Sheet1",
      rows,
    })
    expect(calls[0].url).toContain("valueInputOption=RAW")
    expect(calls[0].url).not.toContain("USER_ENTERED")
    expect(calls[0].body).toEqual({ values: rows })
    expect(result.verification).toMatchObject({
      status: "verified",
      method: "api_readback",
    })
  })

  it("an update whose read-back differs is failed", async () => {
    serve([
      {
        method: "PUT",
        url: new RegExp(`^${esc(SHEETS)}`),
        body: { updatedRange: "Sheet1!B2" },
      },
      { url: new RegExp(`^${esc(SHEETS)}`), body: { values: [["old"]] } },
    ])
    const result = await sheetsUpdate(userId, {
      spreadsheetId: SHEET_ID,
      range: "Sheet1!B2",
      rows: [["new"]],
    })
    expect(result.verification.status).toBe("failed")
  })

  it("maps a 403 to a plain message", async () => {
    serve([{ method: "PUT", url: new RegExp(`^${esc(SHEETS)}`), status: 403, body: {} }])
    await expect(
      sheetsUpdate(userId, { spreadsheetId: SHEET_ID, range: "A1", rows: [["x"]] })
    ).rejects.toThrow(/Sheets access wasn't granted/)
  })

  it("ignores the trailing blanks Google leaves out when reading", () => {
    expect(
      sameCells(
        [
          ["a", ""],
          ["", ""],
        ],
        [["a"]]
      )
    ).toBe(true)
    expect(sameCells([["a", "b"]], [["a"]])).toBe(false)
  })
})

describe("youtube", () => {
  it("parses the channel and its recent uploads", async () => {
    const YT = "https://www.googleapis.com/youtube/v3/"
    serve([
      {
        url: new RegExp(`^${esc(YT)}channels\\?`),
        body: {
          items: [
            {
              id: "UC-test",
              snippet: { title: "Test channel" },
              statistics: { viewCount: "1200", subscriberCount: "45", videoCount: "3" },
              contentDetails: { relatedPlaylists: { uploads: "UU-test" } },
            },
          ],
        },
      },
      {
        url: new RegExp(`^${esc(YT)}playlistItems\\?`),
        body: { items: [{ contentDetails: { videoId: "vid1" } }] },
      },
      {
        url: new RegExp(`^${esc(YT)}videos\\?`),
        body: {
          items: [
            {
              id: "vid1",
              snippet: { title: "Intro", publishedAt: "2026-10-01T00:00:00Z" },
              statistics: { viewCount: "300", likeCount: "20", commentCount: "2" },
            },
          ],
        },
      },
    ])
    const result = await youtubeStats(userId, { limit: 5 })
    expect(result.channel).toEqual({
      id: "UC-test",
      title: "Test channel",
      views: 1200,
      subscribers: 45,
      videos: 3,
    })
    expect(result.recent[0]).toMatchObject({ id: "vid1", views: 300, likes: 20 })
  })
})

describe("undo compensations (K3)", () => {
  const EVENT = "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt1"
  const DRAFT = "https://www.googleapis.com/gmail/v1/users/me/drafts/d1"

  it("deletes the event, telling invitees, and confirms it is cancelled", async () => {
    const calls = serve([
      { method: "DELETE", url: new RegExp(`^${esc(EVENT)}\\?`), status: 204 },
      { url: new RegExp(`^${esc(EVENT)}$`), body: { id: "evt1", status: "cancelled" } },
    ])
    expect(await calendarDelete(userId, "evt1", true)).toBe(true)
    expect(calls[0].url).toContain("sendUpdates=all")
  })

  it("an event still confirmed after the delete is not reported as gone", async () => {
    serve([
      { method: "DELETE", url: new RegExp(`^${esc(EVENT)}\\?`), status: 204 },
      { url: new RegExp(`^${esc(EVENT)}$`), body: { id: "evt1", status: "confirmed" } },
    ])
    expect(await calendarDelete(userId, "evt1", false)).toBe(false)
  })

  it("deletes a draft and confirms it is gone; an already-deleted one counts", async () => {
    serve([
      { method: "DELETE", url: new RegExp(`^${esc(DRAFT)}$`), status: 404, body: {} },
      { url: new RegExp(`^${esc(DRAFT)}$`), status: 404, body: {} },
    ])
    expect(await gmailDeleteDraft(userId, "d1")).toBe(true)
  })
})
