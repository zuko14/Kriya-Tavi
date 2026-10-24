import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Google actions v2 (G2, GOOGLE_CONNECTIVITY §4, OD-15/16/17) on fixtures:
// no Google call leaves the machine. OT-G2-01 drive_import, OT-G2-02
// drive_share (R4, never granted, read back, exact undo), OT-G2-03
// gmail_send_draft (only Kriya's own drafts, R4, the "sent" claim),
// OT-G2-04 switches off leave the belt and prompt as they are.

const seen = vi.hoisted(() => ({ offered: [] as string[][], prompts: [] as string[] }))

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        seen.offered.push((options.tools ?? []).map((t) => t.name).sort())
        const system = options.prompt.find((m) => m.role === "system")
        seen.prompts.push(system && "content" in system ? String(system.content) : "")
        const { say } = await import("./golden/harness")
        return { stream: simulateReadableStream({ chunks: say("Hi.") as never[] }) }
      },
    }),
}))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))

import type { Agent } from "@/db/schema"
import { TOOL_APPROVALS } from "@/lib/agent/run-task"
import { classifyTool } from "@/lib/agent/policy"
import { CAPABILITIES, GRANTABLE } from "@/lib/agent/capabilities"
import { createGoogleV2Tools, SIDE_EFFECT_TOOLS, type ToolEnv } from "@/lib/agent/tools"
import { unconfirmedClaims } from "@/lib/agent/verify"
import { driveShare, googleServices } from "@/lib/connectors"
import { claimFile } from "@/lib/extract"
import { setFileStoreForTests } from "@/lib/files"
import { withGrants } from "@/lib/operator/grants"
import { runUndos, undoLabel, undoOf } from "@/lib/undo"

import { connectedUser, TOKEN } from "../connectors/fixtures"
import { switches, world } from "./golden/harness"

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n")
const DRIVE = "https://www.googleapis.com/drive/v3/files"
const GMAIL = "https://www.googleapis.com/gmail/v1/users/me"

// Answers Drive and Gmail requests; records each one. Unmatched = test failure.
type Reply = { status?: number; json?: unknown; bytes?: Buffer }
function route(handler: (method: string, url: string, body: unknown) => Reply | null) {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
      calls.push({
        method,
        url,
        body,
        auth: new Headers(init?.headers).get("authorization"),
      })
      const reply = handler(method, url, body)
      if (!reply) throw new Error(`No fixture for ${method} ${url}`)
      if (reply.status === 204) return new Response(null, { status: 204 })
      return reply.bytes
        ? new Response(new Uint8Array(reply.bytes), { status: reply.status ?? 200 })
        : new Response(JSON.stringify(reply.json ?? {}), {
            status: reply.status ?? 200,
            headers: { "content-type": "application/json" },
          })
    })
  )
  return calls
}

const objects = new Map<string, Buffer>()
beforeEach(() => {
  objects.clear()
  setFileStoreForTests({
    uploadUrl: async (p) => `https://storage.test/${p}`,
    read: async (p) => objects.get(p) ?? null,
    write: async (p, bytes) => void objects.set(p, bytes),
    signedUrl: async (p) => `https://storage.test/${p}`,
    remove: async () => {},
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  setFileStoreForTests(undefined)
})

const env = (userId: string): ToolEnv => ({
  current: () => ({ id: "a1" }) as Agent,
  userId,
  threadId: "t1",
})
const run = async (tools: Record<string, unknown>, name: string, input: unknown) => {
  const t = tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }
  return t.execute(input, { toolCallId: "c1", messages: [] })
}
const ALL = { driveShare: true, gmailSend: true }
const connected = { google: ["drive", "drive_share", "gmail"] as never[], notion: false }

// A finished task of `user`'s, in a thread of their own
async function taskOf(
  pg: { query: <T>(q: string, p?: unknown[]) => Promise<{ rows: T[] }> },
  user: string
) {
  const tag = user.slice(0, 8)
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'L', 'r', 'g') on conflict do nothing",
    [`a-${tag}`, user]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3) on conflict do nothing",
    [`t-${tag}`, user, `a-${tag}`]
  )
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [user, `t-${tag}`]
  )
  return rows[0]
}

describe("drive_import (OT-G2-01)", () => {
  it("stores a Drive PDF privately as a drive file and queues it for reading", async () => {
    const { pg, userId } = await connectedUser(["google"])
    const calls = route((method, url) =>
      url === `${DRIVE}/F1?alt=media`
        ? { bytes: PDF }
        : url.startsWith(`${DRIVE}/F1?fields=`)
          ? {
              json: {
                id: "F1",
                name: "bill.pdf",
                mimeType: "application/pdf",
                size: String(PDF.length),
              },
            }
          : null
    )
    const out = (await run(
      createGoogleV2Tools(env(userId), connected, ALL),
      "drive_import",
      {
        fileId: "F1",
      }
    )) as { fileId: string; name: string }
    expect(out).toMatchObject({ name: "bill.pdf" })
    const { rows } = await pg.query<{ origin: string; status: string; user_id: string }>(
      "select origin, status, user_id from kriya.files where id = $1",
      [out.fileId]
    )
    expect(rows).toEqual([{ origin: "drive", status: "ready", user_id: userId }])
    expect([...objects.values()]).toEqual([PDF])
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN("google")}`)).toBe(true)
    // The extraction loop picks it up like an upload
    expect((await claimFile("w1", true))?.id).toBe(out.fileId)
  })

  it("exports a Google Doc as PDF", async () => {
    const { userId } = await connectedUser(["google"])
    const calls = route((method, url) =>
      url.startsWith(`${DRIVE}/D1?`)
        ? {
            json: {
              id: "D1",
              name: "Brief",
              mimeType: "application/vnd.google-apps.document",
            },
          }
        : url.startsWith(`${DRIVE}/D1/export?mimeType=application%2Fpdf`)
          ? { bytes: PDF }
          : null
    )
    const out = await run(
      createGoogleV2Tools(env(userId), connected, ALL),
      "drive_import",
      {
        fileId: "D1",
      }
    )
    expect(out).toMatchObject({ name: "Brief.pdf" })
    expect(calls).toHaveLength(2)
  })

  it("refuses unsupported types and oversize files before downloading", async () => {
    const { pg, userId } = await connectedUser(["google"])
    const calls = route((method, url) =>
      url.startsWith(`${DRIVE}/Z1?`)
        ? { json: { id: "Z1", name: "a.zip", mimeType: "application/zip", size: "10" } }
        : url.startsWith(`${DRIVE}/B1?`)
          ? {
              json: {
                id: "B1",
                name: "big.pdf",
                mimeType: "application/pdf",
                size: "30000000",
              },
            }
          : null
    )
    const tools = createGoogleV2Tools(env(userId), connected, ALL)
    await expect(run(tools, "drive_import", { fileId: "Z1" })).rejects.toThrow(
      /can't be imported/
    )
    await expect(run(tools, "drive_import", { fileId: "B1" })).rejects.toThrow(
      /larger than/
    )
    expect(calls.map((c) => c.url).some((u) => u.includes("alt=media"))).toBe(false)
    expect((await pg.query("select 1 from kriya.files")).rows).toEqual([])
  })

  it("is R1 and changes nothing outside Kriya", () => {
    expect(classifyTool("drive_import", {})).toBe("R1")
    expect(SIDE_EFFECT_TOOLS.has("drive_import")).toBe(false)
  })
})

describe("drive_share (OT-G2-02)", () => {
  it("is R4, a side effect, asks every time, and a forged grant never answers it", async () => {
    expect(classifyTool("drive_share", {})).toBe("R4")
    expect(SIDE_EFFECT_TOOLS.has("drive_share")).toBe(true)
    expect(GRANTABLE.has("drive_share")).toBe(false)
    expect(CAPABILITIES.drive_share).toMatchObject({ undoable: true, grantable: false })
    expect((TOOL_APPROVALS as Record<string, unknown>).drive_share).toBe("user-approval")
    const consume = vi.fn(async () => true)
    const map = withGrants(
      TOOL_APPROVALS,
      [
        {
          id: "g1",
          tool: "drive_share" as never,
          pins: { emails: ["a@example.com"] } as never,
          maxUses: 5,
          uses: 0,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
      consume
    )
    expect((map as Record<string, unknown>).drive_share).toBe("user-approval")
    expect(consume).not.toHaveBeenCalled()
  })

  it("adds one permission per address, reads them back, and undo removes only those", async () => {
    const { pg, userId } = await connectedUser(["google"])
    const kept = { id: "p-owner", emailAddress: "owner@example.com", role: "owner" }
    const added: { id: string; emailAddress: string; role: string }[] = []
    let calls = route((method, url, body) => {
      if (method === "POST" && url.startsWith(`${DRIVE}/F1/permissions?`)) {
        const b = body as { emailAddress: string; role: string }
        const p = {
          id: `p${added.length + 1}`,
          emailAddress: b.emailAddress,
          role: b.role,
        }
        added.push(p)
        return { json: p }
      }
      if (method === "GET" && url.startsWith(`${DRIVE}/F1/permissions?`))
        return { json: { permissions: [kept, ...added] } }
      if (method === "GET" && url.startsWith(`${DRIVE}/F1?`))
        return {
          json: { id: "F1", name: "Plan", webViewLink: "https://drive.google.com/x" },
        }
      return null
    })
    const out = await driveShare(userId, {
      fileId: "F1",
      emails: ["a@example.com", "b@example.com"],
      role: "reader",
    })
    expect(out.permissionIds).toEqual(["p1", "p2"])
    expect(out.verification.status).toBe("verified")
    const posts = calls.filter((c) => c.method === "POST")
    expect(posts.map((c) => c.url)).toEqual([
      expect.stringContaining("sendNotificationEmail=true"),
      expect.stringContaining("sendNotificationEmail=true"),
    ])

    const undo = undoOf("drive_share", out)
    expect(undo).toEqual({
      kind: "drive_permissions",
      fileId: "F1",
      permissionIds: ["p1", "p2"],
    })
    expect(undoLabel(undo!)).toMatch(/Remove/)

    // The worker runs the queued compensation
    const task = await taskOf(pg, userId)
    await pg.query(
      `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, input)
       values ($1, $2, 1, 'undo:c1', 'undo:drive_share', true, $3)`,
      [task.id, userId, JSON.stringify(undo)]
    )
    calls = route((method, url) => {
      const m = /permissions\/(p\d)/.exec(url)
      if (method === "DELETE" && m) {
        added.splice(
          added.findIndex((p) => p.id === m[1]),
          1
        )
        return { status: 204 }
      }
      if (method === "GET" && url.startsWith(`${DRIVE}/F1/permissions?`))
        return { json: { permissions: [kept, ...added] } }
      return null
    })
    expect(await runUndos()).toBe(1)
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringContaining("/permissions/p1"),
      expect.stringContaining("/permissions/p2"),
    ])
    const { rows } = await pg.query<{ status: string }>(
      "select status from kriya.tool_executions where tool_call_id = 'undo:c1'"
    )
    expect(rows).toEqual([{ status: "succeeded" }])
  })

  it("the sharing scope is its own opt-in service", () => {
    expect(googleServices(["https://www.googleapis.com/auth/drive.readonly"])).toEqual([
      "drive",
    ])
    expect(googleServices(["https://www.googleapis.com/auth/drive"])).toContain(
      "drive_share"
    )
  })
})

describe("gmail_send_draft (OT-G2-03)", () => {
  it("sends only a draft Kriya saved for this person, and reads it back from Sent", async () => {
    const { pg, userId } = await connectedUser(["google"])
    const other = (
      await pg.query<{ id: string }>(
        "insert into auth.users (id) values (gen_random_uuid()) returning id"
      )
    ).rows[0].id
    const saved = async (user: string, draftId: string) => {
      const task = await taskOf(pg, user)
      await pg.query(
        `insert into kriya.tool_executions (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, status, output_summary)
         values ($1, $2, 1, $3, 'gmail_draft', true, 'succeeded', $4)`,
        [
          task.id,
          user,
          `d-${draftId}`,
          JSON.stringify({ draftId, link: "https://mail.google.com" }),
        ]
      )
    }
    await saved(userId, "r-mine")
    await saved(other, "r-theirs")
    const calls = route((method, url, body) => {
      if (method === "POST" && url === `${GMAIL}/drafts/send`)
        return (body as { id: string }).id === "r-mine"
          ? { json: { id: "m1", threadId: "t1" } }
          : null
      if (method === "GET" && url.startsWith(`${GMAIL}/messages/m1?`))
        return { json: { id: "m1", labelIds: ["SENT"] } }
      return null
    })
    const tools = createGoogleV2Tools(env(userId), connected, ALL)
    await expect(run(tools, "gmail_send_draft", { draftId: "r-theirs" })).rejects.toThrow(
      /Kriya saved/
    )
    await expect(
      run(tools, "gmail_send_draft", { draftId: "r-unknown" })
    ).rejects.toThrow(/Kriya saved/)
    expect(calls).toEqual([])
    const out = (await run(tools, "gmail_send_draft", { draftId: "r-mine" })) as {
      messageId: string
      verification: { status: string }
    }
    expect(out).toMatchObject({ messageId: "m1", verification: { status: "verified" } })
  })

  it("is R4, asks every time, is never grantable", () => {
    expect(classifyTool("gmail_send_draft", {})).toBe("R4")
    expect(SIDE_EFFECT_TOOLS.has("gmail_send_draft")).toBe(true)
    expect(GRANTABLE.has("gmail_send_draft")).toBe(false)
    expect((TOOL_APPROVALS as Record<string, unknown>).gmail_send_draft).toBe(
      "user-approval"
    )
  })

  it('backs "I sent …" only with a sent draft; otherwise the reason is as before', () => {
    const before = unconfirmedClaims("I sent the reminder to Asha.", [])
    expect(before).toEqual([
      {
        claim: "I sent the reminder to Asha.",
        reason: "Kriya can't send email or post; at most a draft was saved.",
      },
    ])
    expect(
      unconfirmedClaims("I sent the reminder to Asha.", [
        { tool: "gmail_send_draft", status: "succeeded" },
      ])
    ).toEqual([])
    expect(
      unconfirmedClaims("I sent the reminder to Asha.", [
        { tool: "gmail_send_draft", status: "failed" },
      ])
    ).toEqual(before)
    // Posting still has no tool behind it
    expect(
      unconfirmedClaims("I posted it.", [
        { tool: "gmail_send_draft", status: "succeeded" },
      ])
    ).toHaveLength(1)
  })
})

describe("switches off (OT-G2-04, OT-REG-01)", () => {
  afterEach(() => {
    delete process.env.KRIYA_OPERATOR_DRIVE_SHARE
    delete process.env.KRIYA_OPERATOR_GMAIL_SEND
    switches(false)
  })

  it("the factory offers nothing with both off", () => {
    expect(
      createGoogleV2Tools(env("u"), connected, { driveShare: false, gmailSend: false })
    ).toEqual({})
  })

  it("the belt and prompt are the same unset or off; on adds only the new tools", async () => {
    const w = await world()
    const reset = () =>
      ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)
    await w.turn("hello")
    process.env.KRIYA_OPERATOR_DRIVE_SHARE = "off"
    process.env.KRIYA_OPERATOR_GMAIL_SEND = "off"
    reset()
    await w.turn("hello")
    expect(seen.offered.at(-1)).toEqual(seen.offered.at(-2))
    expect(seen.prompts.at(-1)).toBe(seen.prompts.at(-2))
    process.env.KRIYA_OPERATOR_GMAIL_SEND = "on"
    reset()
    await w.turn("hello")
    expect(seen.offered.at(-1)).toEqual(
      [...seen.offered.at(-2)!, "gmail_send_draft"].sort()
    )
    expect(seen.prompts.at(-1)).toBe(seen.prompts.at(-2))
  })
})

describe("calendar_delete_event (operator.calendarDelete)", () => {
  const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
  const calendar = { google: ["calendar"] as never[], notion: false }
  const on = { driveShare: false, gmailSend: false, calendarDelete: true }
  const meeting = {
    id: "ev_1",
    summary: "Meeting with Taiyo Labs",
    start: { dateTime: "2026-10-24T10:00:00+05:30" },
    end: { dateTime: "2026-10-24T11:00:00+05:30" },
    attendees: [{ email: "Asha@Example.test" }],
  }
  const input = {
    eventId: "ev_1",
    title: "Meeting with Taiyo Labs",
    start: "2026-10-24T10:00:00+05:30",
    attendees: ["asha@example.test"],
  }

  it("deletes the approved event without emailing guests, and reads it back gone", async () => {
    const { userId } = await connectedUser(["google"])
    let deleted = false
    const calls = route((method, url) => {
      if (method === "GET" && url === `${EVENTS}/ev_1`)
        return deleted ? { status: 410, json: {} } : { json: meeting }
      if (method === "DELETE" && url === `${EVENTS}/ev_1?sendUpdates=none`) {
        deleted = true
        return { status: 204 }
      }
      return null
    })
    const out = await run(
      createGoogleV2Tools(env(userId), calendar, on),
      "calendar_delete_event",
      input
    )
    expect(out).toMatchObject({
      id: "ev_1",
      deleted: true,
      verification: { status: "verified", method: "api_readback" },
    })
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET"])
    expect(calls[1].auth).toBe(`Bearer ${TOKEN("google")}`)
  })

  it("deletes nothing when the event isn't the one the person approved", async () => {
    const { userId } = await connectedUser(["google"])
    const calls = route((method, url) =>
      method === "GET" && url === `${EVENTS}/ev_1` ? { json: meeting } : null
    )
    const tools = createGoogleV2Tools(env(userId), calendar, on)
    await expect(
      run(tools, "calendar_delete_event", { ...input, title: "Dentist" })
    ).rejects.toThrow(/nothing was deleted/)
    await expect(
      run(tools, "calendar_delete_event", {
        ...input,
        start: "2026-10-25T10:00:00+05:30",
      })
    ).rejects.toThrow(/nothing was deleted/)
    // The card showed other guests than the event has
    await expect(
      run(tools, "calendar_delete_event", { ...input, attendees: [] })
    ).rejects.toThrow(/1 guest/)
    expect(calls.every((c) => c.method === "GET")).toBe(true)
  })

  it("fails the read-back when the event is still there", async () => {
    const { userId } = await connectedUser(["google"])
    route((method, url) =>
      method === "GET" && url === `${EVENTS}/ev_1`
        ? { json: meeting }
        : method === "DELETE"
          ? { status: 204 }
          : null
    )
    const out = await run(
      createGoogleV2Tools(env(userId), calendar, on),
      "calendar_delete_event",
      input
    )
    expect(out).toMatchObject({ deleted: false, verification: { status: "failed" } })
  })

  it("is R3, asks every time, is never grantable, and needs the switch and Calendar", () => {
    expect(classifyTool("calendar_delete_event", {})).toBe("R3")
    expect(SIDE_EFFECT_TOOLS.has("calendar_delete_event")).toBe(true)
    expect(GRANTABLE.has("calendar_delete_event")).toBe(false)
    expect(CAPABILITIES.calendar_delete_event.verification).toBe("api_readback")
    expect((TOOL_APPROVALS as Record<string, unknown>).calendar_delete_event).toBe(
      "user-approval"
    )
    expect(
      createGoogleV2Tools(env("u"), calendar, { ...on, calendarDelete: false })
    ).toEqual({})
    // Without Calendar connected the switch alone adds nothing
    expect(createGoogleV2Tools(env("u"), connected, on)).toEqual({})
  })

  it('backs "I deleted the event" only with a successful delete', () => {
    const claim = "I deleted the meeting from your calendar."
    expect(unconfirmedClaims(claim, [])).toHaveLength(1)
    expect(
      unconfirmedClaims(claim, [{ tool: "calendar_delete_event", status: "succeeded" }])
    ).toEqual([])
    expect(
      unconfirmedClaims(claim, [{ tool: "calendar_delete_event", status: "failed" }])
    ).toHaveLength(1)
  })

  it("the runner offers it only with the switch on and Calendar connected", async () => {
    const w = await world()
    const reset = () =>
      ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)
    await w.pg.query(
      "update kriya.connections set scopes = scopes || array['https://www.googleapis.com/auth/calendar.events']"
    )
    try {
      await w.turn("hello")
      const before = seen.offered.at(-1)!
      expect(before).not.toContain("calendar_delete_event")
      process.env.KRIYA_OPERATOR_CALENDAR_DELETE = "on"
      reset()
      await w.turn("hello")
      expect(seen.offered.at(-1)).toEqual([...before, "calendar_delete_event"].sort())
    } finally {
      delete process.env.KRIYA_OPERATOR_CALENDAR_DELETE
      switches(false)
    }
  })
})
