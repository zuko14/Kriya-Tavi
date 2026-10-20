import { describe, expect, it } from "vitest"

import {
  exotelConfigFromEnv,
  exotelStatus,
  exotelTelephony,
  exotelTime,
} from "@/lib/voice/exotel"

// The Exotel adapter against fixtures shaped like developer.exotel.com's
// voice-v1 examples (connect-to-flow, call-details, references/webhooks),
// read 2026-10-20. Ids, numbers and URLs are redacted or synthetic; replace
// them with redacted payloads from the first test call (X5, X9). No network.

const SID = "kriyatest1"
const CALL = "c0ffee00000000000000000000001a2b"

const FIXTURES = {
  connect: {
    Call: {
      Sid: CALL,
      AccountSid: SID,
      To: null,
      From: "+919000000001",
      PhoneNumberSid: "09000000000",
      Status: "in-progress",
      Direction: "outbound-api",
      StartTime: "2026-10-20 15:04:05",
      EndTime: null,
      Duration: null,
      Price: null,
      AnsweredBy: null,
      RecordingUrl: null,
      Uri: `/v1/Accounts/${SID}/Calls/${CALL}.json`,
    },
  },
  completed: {
    Call: {
      Sid: CALL,
      AccountSid: SID,
      From: "+919000000001",
      Status: "completed",
      Direction: "outbound-api",
      StartTime: "2026-10-20 15:04:05",
      EndTime: "2026-10-20 15:05:22",
      Duration: "77",
      Price: "1.500",
      AnsweredBy: null,
      Details: {
        ConversationDuration: 61,
        Leg1Status: "completed",
        Leg2Status: null,
        Legs: [{ Leg: { Id: 1, OnCallDuration: 77 } }],
      },
    },
  },
  noAnswer: {
    Call: {
      Sid: CALL,
      Status: "no-answer",
      StartTime: "2026-10-20 15:04:05",
      EndTime: "2026-10-20 15:04:35",
      Duration: "0",
      Details: { ConversationDuration: 0 },
    },
  },
  terminalCallback: {
    CallSid: CALL,
    EventType: "terminal",
    DateCreated: "2026-10-20 15:04:03",
    DateUpdated: "2026-10-20 15:05:22",
    From: "+919000000001",
    StartTime: "2026-10-20 15:04:05",
    EndTime: "2026-10-20 15:05:22",
    Status: "completed",
    ConversationDuration: 61,
    Direction: "outbound-api",
    CustomField: "11111111-2222-4333-8444-555555555555",
    RecordingUrl: null,
    Legs: [{ OnCallDuration: 77, Status: "completed", AnsweredBy: "NA" }],
  },
}

type Sent = { url: string; init: RequestInit }

function fakeExotel(...responses: [number, unknown][]) {
  const sent: Sent[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    const [status, body] = responses.shift() ?? [500, {}]
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof globalThis.fetch
  const provider = exotelTelephony({
    accountSid: SID,
    apiKey: "key",
    apiToken: "token",
    host: "api.exotel.com",
    flowUrl: `http://my.exotel.com/${SID}/exoml/start_voice/123456`,
    fetch,
  })
  return { provider, sent }
}

const input = {
  attemptId: "11111111-2222-4333-8444-555555555555",
  to: "+919000000001",
  callerId: "09000000000",
  streamUrl: "wss://voice.kriya.test/media/exotel?t=x",
  statusUrl: "https://kriya.test/api/voice/exotel/status/token",
  ringTimeoutSeconds: 30,
  maxDurationSeconds: 300,
}

describe("Exotel adapter", () => {
  it("places a call to the flow with Basic auth, CustomField, limits and callbacks", async () => {
    const { provider, sent } = fakeExotel([200, FIXTURES.connect])
    expect(await provider.placeCall(input)).toEqual({ providerCallId: CALL })
    const [{ url, init }] = sent
    expect(url).toBe(`https://api.exotel.com/v1/Accounts/${SID}/Calls/connect.json`)
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("key:token").toString("base64")}`
    )
    const form = new URLSearchParams(String(init.body))
    expect(Object.fromEntries(form)).toMatchObject({
      From: input.to,
      CallerId: input.callerId,
      Url: `http://my.exotel.com/${SID}/exoml/start_voice/123456`,
      CallType: "trans",
      CustomField: input.attemptId,
      TimeOut: "30",
      TimeLimit: "300",
      StatusCallback: input.statusUrl,
      StatusCallbackContentType: "application/json",
      "StatusCallbackEvents[0]": "terminal",
      "StatusCallbackEvents[1]": "answered",
    })
  })

  it("no status URL: no callback parameters", async () => {
    const { provider, sent } = fakeExotel([200, FIXTURES.connect])
    await provider.placeCall({ ...input, statusUrl: "" })
    expect(String(sent[0].init.body)).not.toMatch(/StatusCallback/)
  })

  it("a 4xx carries its status (refused: no call made) and no body text", async () => {
    const { provider } = fakeExotel([
      401,
      { RestException: { Message: "+919000000001" } },
    ])
    const error = await provider.placeCall(input).catch((e) => e)
    expect(error.status).toBe(401)
    expect(error.message).toBe("Exotel answered 401: ***0001")
  })

  it("a 2xx without a call id is not a refusal (it may have dialled)", async () => {
    const { provider } = fakeExotel([200, {}])
    const error = await provider.placeCall(input).catch((e) => e)
    expect(error.status).toBeUndefined()
  })

  it("reads call details: status, IST times, billed seconds; never a cost from Price", async () => {
    const { provider, sent } = fakeExotel([200, FIXTURES.completed])
    const call = await provider.getCall(CALL)
    expect(sent[0].url).toBe(
      `https://api.exotel.com/v1/Accounts/${SID}/Calls/${CALL}.json?details=true`
    )
    expect(call).toMatchObject({
      providerCallId: CALL,
      status: "completed",
      answeredAt: new Date("2026-10-20T09:34:05Z"),
      endedAt: new Date("2026-10-20T09:35:22Z"),
      billableSeconds: 77,
      reportedCost: null,
    })
  })

  it("an unanswered call has no answer time; an unknown call is null", async () => {
    const { provider } = fakeExotel([200, FIXTURES.noAnswer], [404, {}], [500, {}])
    expect(await provider.getCall(CALL)).toMatchObject({
      status: "no_answer",
      answeredAt: null,
      billableSeconds: 0,
    })
    expect(await provider.getCall("missing")).toBeNull()
    // Unreachable is an error, so verification asks again later
    await expect(provider.getCall(CALL)).rejects.toMatchObject({ status: 500 })
  })

  it("a details answer for another call is not this call", async () => {
    const { provider } = fakeExotel([200, FIXTURES.completed])
    expect(await provider.getCall("other")).toBeNull()
  })

  it("parses a JSON status callback", () => {
    const { provider } = fakeExotel()
    const event = provider.parseStatusEvent(
      JSON.stringify(FIXTURES.terminalCallback),
      new Headers()
    )
    expect(event).toMatchObject({
      providerCallId: CALL,
      attemptId: input.attemptId,
      status: "completed",
      occurredAt: new Date("2026-10-20T09:35:22Z"),
    })
    expect(event!.dedupeKey).toBe(`${CALL}:terminal:completed:2026-10-20 15:05:22`)
  })

  it("parses a form callback and the answered event", () => {
    const { provider } = fakeExotel()
    const form = new URLSearchParams({
      CallSid: CALL,
      EventType: "answered",
      Status: "in-progress",
      DateUpdated: "2026-10-20 15:04:12",
      CustomField: input.attemptId,
    })
    const answered = provider.parseStatusEvent(String(form), new Headers())
    expect(answered).toMatchObject({ status: "answered", attemptId: input.attemptId })
    // Default payload: CallSid, DateUpdated, Status only
    const terminal = provider.parseStatusEvent(
      `CallSid=${CALL}&Status=busy&DateUpdated=2026-10-20+15%3A04%3A40`,
      new Headers()
    )
    expect(terminal).toMatchObject({ status: "busy", attemptId: null })
    expect(terminal!.dedupeKey).not.toBe(answered!.dedupeKey)
  })

  it("refuses bodies without a call id", () => {
    const { provider } = fakeExotel()
    for (const body of [
      "",
      "garbage",
      "[]",
      "null",
      JSON.stringify({ Status: "completed" }),
    ]) {
      expect(provider.parseStatusEvent(body, new Headers()), body).toBeNull()
    }
  })

  it("hangup says plainly that Exotel can't (TimeLimit ends the call)", async () => {
    const { provider, sent } = fakeExotel()
    await expect(provider.hangup(CALL)).rejects.toThrow(/TimeLimit/)
    expect(sent).toEqual([])
  })

  it("maps every documented status and zone-less time", () => {
    expect(
      [
        "queued",
        "ringing",
        "in-progress",
        "completed",
        "busy",
        "no-answer",
        "failed",
        "x",
      ].map(exotelStatus)
    ).toEqual([
      "initiated",
      "ringing",
      "answered",
      "completed",
      "busy",
      "no_answer",
      "failed",
      "unknown",
    ])
    expect(exotelTime("2026-10-20 00:00:00")).toEqual(new Date("2026-10-19T18:30:00Z"))
    expect(exotelTime(null)).toBeNull()
    expect(exotelTime("2026-10-20T00:00:00Z")).toBeNull()
  })

  it("is configured only when every variable is set", () => {
    const env = {
      EXOTEL_ACCOUNT_SID: SID,
      EXOTEL_API_KEY: "k",
      EXOTEL_API_TOKEN: "t",
      EXOTEL_SUBDOMAIN: "api.exotel.com",
      EXOTEL_FLOW_URL: "http://my.exotel.com/x/exoml/start_voice/1",
    }
    expect(exotelConfigFromEnv(env)).toMatchObject({ host: "api.exotel.com" })
    expect(exotelConfigFromEnv({ ...env, EXOTEL_FLOW_URL: " " })).toBeNull()
  })
})
