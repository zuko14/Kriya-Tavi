import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// HT-APR-01…03 and HT-API-09 for the approval routes (H5, HD-08): a device
// asks, the person's Inbox lists it, only a signed-in session answers, the
// device's long-poll returns the answer. Expiry, local cancel and first
// answer wins; inputs are redacted before they're stored. PX-03, track H's
// part: /api/events announces a new request.

const session = vi.hoisted(() => ({ user: "" }))
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/auth", async (original) => {
  // No session → requireUser throws, as the real one redirects
  const signedIn = async () => {
    if (!session.user) throw new Error("NEXT_REDIRECT")
    return { id: session.user, email: null }
  }
  return {
    ...(await original<typeof import("@/lib/auth")>()),
    requireUser: signedIn,
    authenticate: async () => (session.user ? { id: session.user, email: null } : null),
  }
})

import { answerHarnessApproval } from "@/actions/harness"
import * as one from "@/app/api/harness/v1/approvals/[id]/route"
import * as many from "@/app/api/harness/v1/approvals/route"
import { GET as events } from "@/app/api/events/route"
import type { KriyaEvent } from "@/lib/events"
import {
  ApprovalCreateResponse,
  ApprovalStatusResponse,
  ErrorResponse,
} from "@/lib/harness/contract"
import { getInbox, inboxCount } from "@/queries/inbox"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let newUser: () => Promise<string>

const REQUEST = {
  sessionRef: "s-1",
  tool: "bash",
  summary: "Run the test suite",
  input: { command: "npm test" },
  cwd: "/home/dev/app",
}

async function ask(token: string, body: unknown = REQUEST) {
  return many.POST(call("POST", "/approvals", { token, body }))
}

async function asked(token: string, body: unknown = REQUEST) {
  const res = await ask(token, body)
  expect(res.status).toBe(201)
  return ApprovalCreateResponse.parse(await res.json())
}

const status = async (token: string, id: string, wait?: number) => {
  const res = await one.GET(
    call("GET", `/approvals/${id}${wait === undefined ? "" : `?wait=${wait}`}`, {
      token,
    })
  )
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

const cancel = (token: string, id: string) =>
  one.DELETE(call("DELETE", `/approvals/${id}`, { token }))

const answer = (user: string, id: string, decision: "approved" | "declined") => {
  session.user = user
  return answerHarnessApproval(id, decision)
}

async function person() {
  const user = await newUser()
  const device = await deviceFor(pg, user)
  return { user, ...device }
}

const stored = async (id: string) =>
  (
    await pg.query<{ status: string; input: unknown; answered_at: Date | null }>(
      "select status, input, answered_at from kriya.harness_approval_requests where id = $1",
      [id]
    )
  ).rows[0]

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
})
beforeEach(() => {
  session.user = ""
  harnessEnv()
})

describe("HT-APR-01: request → Inbox → session answer → long-poll", () => {
  it("the device's request appears in its person's Inbox only, counted in the badge", async () => {
    const a = await person()
    const b = await person()
    const { id, expiresAt } = await asked(a.token)
    // harness.approvalTtlMinutes, default 30
    const ttl = new Date(expiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(29 * 60_000)
    expect(ttl).toBeLessThanOrEqual(30 * 60_000)

    const inbox = await getInbox(a.user)
    expect(inbox.harnessApprovals).toEqual([
      expect.objectContaining({
        id,
        tool: "bash",
        summary: "Run the test suite",
        input: { command: "npm test" },
        cwd: "/home/dev/app",
        deviceName: "laptop",
      }),
    ])
    expect(await inboxCount(a.user)).toBe(1)
    expect((await getInbox(b.user)).harnessApprovals).toEqual([])
    expect(await inboxCount(b.user)).toBe(0)
  })

  it("a waiting long-poll wakes with the session's answer", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    const started = Date.now()
    const polled = status(a.token, id, 10)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await answer(a.user, id, "approved")).toEqual({ ok: true })
    const res = await polled
    expect(res.code).toBe(200)
    expect(ApprovalStatusResponse.parse(res.body)).toEqual({ status: "approved" })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((await stored(id)).answered_at).toBeInstanceOf(Date)
    expect((await getInbox(a.user)).harnessApprovals).toEqual([])
  })

  it("without wait the status comes back at once; a long-poll times out still pending", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    expect((await status(a.token, id)).body).toEqual({ status: "pending" })
    const started = Date.now()
    expect((await status(a.token, id, 1)).body).toEqual({ status: "pending" })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect((await status(a.token, id, 26)).code).toBe(400)
    expect((await status(a.token, id, -1)).code).toBe(400)
  })

  it("another person can't answer, read or cancel it; nor can the person's other device", async () => {
    const a = await person()
    const b = await person()
    const other = await deviceFor(pg, a.user)
    const { id } = await asked(a.token)
    expect(await answer(b.user, id, "approved")).toMatchObject({
      error: expect.any(String),
    })
    expect((await status(b.token, id)).code).toBe(404)
    expect((await status(other.token, id)).code).toBe(404)
    expect((await cancel(b.token, id)).status).toBe(404)
    expect((await stored(id)).status).toBe("pending")
  })

  it("a revoked device's request leaves the Inbox", async () => {
    const a = await person()
    await asked(a.token)
    await pg.query("update kriya.harness_devices set revoked_at = now() where id = $1", [
      a.deviceId,
    ])
    expect((await getInbox(a.user)).harnessApprovals).toEqual([])
  })

  it("at most two long-polls per device at a time", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    const open = [status(a.token, id, 2), status(a.token, id, 2)]
    await new Promise((resolve) => setTimeout(resolve, 100))
    const third = await status(a.token, id, 2)
    expect(third.code).toBe(429)
    expect((await Promise.all(open)).map((r) => r.code)).toEqual([200, 200])
    expect((await status(a.token, id, 0)).code).toBe(200)
  })

  it("with harness.api off: no Inbox entry, no answer, no route", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    harnessEnv({ KRIYA_HARNESS_API: undefined })
    expect((await getInbox(a.user)).harnessApprovals).toEqual([])
    expect(await inboxCount(a.user)).toBe(0)
    expect(await answer(a.user, id, "approved")).toMatchObject({
      error: expect.any(String),
    })
    expect((await status(a.token, id)).code).toBe(404)
    expect((await ask(a.token)).status).toBe(404)
    expect((await stored(id)).status).toBe("pending")
  })
})

describe("HT-APR-02: expiry, local cancel, first answer wins", () => {
  it("past its expiry it reads expired, leaves the Inbox and can't be answered", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    await pg.query(
      "update kriya.harness_approval_requests set expires_at = now() - interval '1 second' where id = $1",
      [id]
    )
    expect((await getInbox(a.user)).harnessApprovals).toEqual([])
    expect(await answer(a.user, id, "approved")).toMatchObject({
      error: expect.any(String),
    })
    expect((await status(a.token, id)).body).toEqual({ status: "expired" })
    expect((await stored(id)).status).toBe("expired")
  })

  it("DELETE cancels a pending request (answered in the terminal)", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    expect((await cancel(a.token, id)).status).toBe(204)
    expect((await stored(id)).status).toBe("canceled")
    expect((await status(a.token, id)).body).toEqual({ status: "canceled" })
    expect(await answer(a.user, id, "approved")).toMatchObject({
      error: expect.any(String),
    })
    expect((await getInbox(a.user)).harnessApprovals).toEqual([])
  })

  it("an answered request doesn't change: not by a second answer, not by a cancel", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    expect(await answer(a.user, id, "declined")).toEqual({ ok: true })
    expect(await answer(a.user, id, "approved")).toMatchObject({
      error: expect.any(String),
    })
    expect((await cancel(a.token, id)).status).toBe(204)
    expect((await stored(id)).status).toBe("declined")
    expect((await status(a.token, id)).body).toEqual({ status: "declined" })
  })

  it("an unknown or malformed id is 404", async () => {
    const a = await person()
    expect((await status(a.token, crypto.randomUUID())).code).toBe(404)
    expect((await status(a.token, "not-a-uuid")).code).toBe(404)
    expect((await cancel(a.token, "not-a-uuid")).status).toBe(404)
    expect(await answer(a.user, "not-a-uuid", "approved")).toMatchObject({
      error: expect.any(String),
    })
  })
})

describe("HT-APR-03: the card shows the exact, redacted input", () => {
  it("secrets are redacted before they're stored; tool and folder kept", async () => {
    const a = await person()
    const { id } = await asked(a.token, {
      ...REQUEST,
      tool: "web_fetch",
      input: {
        url: "https://example.test",
        apiToken: "abc123",
        auth: { password: "pw" },
      },
    })
    const expected = {
      url: "https://example.test",
      apiToken: "[redacted]",
      auth: { password: "[redacted]" },
    }
    expect((await stored(id)).input).toEqual(expected)
    const [card] = (await getInbox(a.user)).harnessApprovals
    expect(card).toMatchObject({
      tool: "web_fetch",
      cwd: "/home/dev/app",
      input: expected,
    })
    expect(JSON.stringify(card)).not.toMatch(/abc123|"pw"/)
  })

  it("HF-12: a secret in a 4–8 KB input is redacted, not stored truncated in clear", async () => {
    const a = await person()
    const { id } = await asked(a.token, {
      ...REQUEST,
      // The secret first: redactInput alone would keep it in its first 4 000 characters
      input: { env: { GITHUB_TOKEN: "ghp_secret" }, script: "x".repeat(5_000) },
    })
    const kept = JSON.stringify((await stored(id)).input)
    expect(kept).not.toContain("ghp_secret")
  })

  it("the request is the contract: limits enforced, unknown fields refused", async () => {
    const a = await person()
    for (const body of [
      { ...REQUEST, tool: "t".repeat(61) },
      { ...REQUEST, summary: "s".repeat(301) },
      { ...REQUEST, sessionRef: "r".repeat(101) },
      { ...REQUEST, cwd: "c".repeat(301) },
      { ...REQUEST, input: { blob: "x".repeat(8_200) } },
      { ...REQUEST, input: "not an object" },
      { ...REQUEST, status: "approved" },
      { ...REQUEST, tool: "" },
    ]) {
      const res = await ask(a.token, body)
      expect(res.status).toBe(400)
      ErrorResponse.parse(await res.json())
    }
    const noFolder: Record<string, unknown> = { ...REQUEST }
    delete noFolder.cwd
    expect((await ask(a.token, noFolder)).status).toBe(201)
  })
})

describe("HT-API-09: no device endpoint answers an approval", () => {
  it("the routes only ask, read and cancel", () => {
    expect(Object.keys(many).sort()).toEqual(["POST"])
    expect(Object.keys(one).sort()).toEqual(["DELETE", "GET"])
  })

  it("a device token without a session can't answer", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    session.user = ""
    await expect(answerHarnessApproval(id, "approved")).rejects.toThrow()
    expect((await stored(id)).status).toBe("pending")
  })

  it("routes need the device token", async () => {
    const a = await person()
    const { id } = await asked(a.token)
    expect((await many.POST(call("POST", "/approvals", { body: REQUEST }))).status).toBe(
      401
    )
    expect((await one.GET(call("GET", `/approvals/${id}`))).status).toBe(401)
    expect((await one.DELETE(call("DELETE", `/approvals/${id}`))).status).toBe(401)
  })
})

describe("PX-03: /api/events announces a new request", () => {
  async function eventsFor(user: string) {
    session.user = user
    const response = await events(new Request("https://kriya.example/api/events"))
    const reader = response.body!.getReader()
    let text = ""
    while (!text.includes(": keep-alive")) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    await reader.cancel()
    return [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]) as KriyaEvent)
  }

  it("to its person only, naming the tool and device, never the input", async () => {
    const a = await person()
    const b = await person()
    const { id } = await asked(a.token, { ...REQUEST, input: { command: "secret-cmd" } })
    const seen = await eventsFor(a.user)
    expect(seen).toEqual([
      {
        type: "harness-approval",
        threadId: id,
        href: "/inbox",
        name: "laptop",
        glyph: `harness-${a.deviceId}`,
        tool: "bash",
      },
    ])
    expect(JSON.stringify(seen)).not.toMatch(/secret-cmd|Run the test suite/)
    expect(await eventsFor(b.user)).toEqual([])
    harnessEnv({ KRIYA_HARNESS_API: undefined })
    expect(await eventsFor(a.user)).toEqual([])
  })
})
