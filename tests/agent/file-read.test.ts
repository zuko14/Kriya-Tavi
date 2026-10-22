import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// file_read (A5, TOOLS_AND_CONTRACTS §2.3): the extracted text of one of the
// person's own files, capped and marked as someone else's words; it counts
// as private content, so a web request afterwards asks first. Behind
// agents.files: off, the belt and prompt are as before.

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
        const { say } = await import("../operator/golden/harness")
        return { stream: simulateReadableStream({ chunks: say("Hi.") as never[] }) }
      },
    }),
}))

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import type { Agent } from "@/db/schema"
import { classifyTool } from "@/lib/agent/policy"
import { createFileTools, FOREIGN, PRIVATE_READ_TOOLS } from "@/lib/agent/tools"
import { READ_CHARS } from "@/lib/files"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { switches, world } from "../operator/golden/harness"

let pg: TestDb
let alice: string
let bob: string

const file = async (user: string, status: string, text: string | null, reason?: string) =>
  (
    await pg.query<{ id: string }>(
      `insert into kriya.files (user_id, name, mime, size_bytes, origin, status, sha256, text, extraction)
       values ($1, 'bill.pdf', 'application/pdf', 10, 'drive', $2, $3, $4, $5) returning id`,
      [
        user,
        status,
        status === "pending" ? null : "a".repeat(64),
        text,
        JSON.stringify({ pages: 2, ...(reason && { reason }) }),
      ]
    )
  ).rows[0].id

const read = async (user: string, input: unknown) => {
  const tools = createFileTools(
    {
      current: () => ({ id: "a1" }) as Agent,
      userId: user,
      threadId: "t1",
    },
    { google: [], notion: false } as never
  )
  return tools.file_read.execute!(
    input as never,
    { toolCallId: "c1", messages: [] } as never
  )
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
})

describe("file_read", () => {
  it("returns the person's extracted text, marked as someone else's words", async () => {
    const id = await file(alice, "extracted", "Total due: ₹1,180 by 30 Oct.")
    expect(await read(alice, { fileId: id })).toEqual({
      notice: FOREIGN,
      fileId: id,
      name: "bill.pdf",
      mime: "application/pdf",
      pages: 2,
      start: 0,
      total: 28,
      text: "Total due: ₹1,180 by 30 Oct.",
    })
  })

  it("pages a long text by character offset", async () => {
    const text = "x".repeat(READ_CHARS) + "tail"
    const id = await file(alice, "extracted", text)
    const first = (await read(alice, { fileId: id })) as {
      text: string
      nextStart: number
    }
    expect(first.text).toHaveLength(READ_CHARS)
    expect(first.nextStart).toBe(READ_CHARS)
    const second = (await read(alice, { fileId: id, start: READ_CHARS })) as {
      text: string
      nextStart?: number
    }
    expect(second.text).toBe("tail")
    expect(second).not.toHaveProperty("nextStart")
  })

  it("another person's file isn't there; unread and unreadable files say so", async () => {
    const theirs = await file(bob, "extracted", "Bob's secret")
    expect(await read(alice, { fileId: theirs })).toMatchObject({
      error: expect.any(String),
    })
    expect(JSON.stringify(await read(alice, { fileId: theirs }))).not.toContain("secret")
    const waiting = await file(alice, "ready", null)
    expect(await read(alice, { fileId: waiting })).toMatchObject({
      error: expect.stringMatching(/hasn't read/),
    })
    const failed = await file(alice, "failed", null, "Password-protected PDF.")
    expect(await read(alice, { fileId: failed })).toMatchObject({
      error: expect.stringContaining("Password-protected PDF."),
    })
  })

  it("is R0 and counts as private content (a web request afterwards asks)", () => {
    expect(classifyTool("file_read", {})).toBe("R0")
    expect(PRIVATE_READ_TOOLS.has("file_read")).toBe(true)
  })
})

describe("behind agents.files (AT-REG-01)", () => {
  afterEach(() => {
    delete process.env.KRIYA_AGENTS_FILES
    switches(false)
  })

  it("off: the belt and prompt are as before; on: the file tools join", async () => {
    const w = await world()
    const reset = () =>
      ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)
    await w.turn("hello")
    process.env.KRIYA_AGENTS_FILES = "off"
    reset()
    await w.turn("hello")
    expect(seen.offered.at(-1)).toEqual(seen.offered.at(-2))
    expect(seen.prompts.at(-1)).toBe(seen.prompts.at(-2))
    process.env.KRIYA_AGENTS_FILES = "on"
    reset()
    await w.turn("hello")
    expect(seen.offered.at(-1)).toEqual(
      [...seen.offered.at(-2)!, "document_render", "file_list", "file_read"].sort()
    )
    expect(seen.prompts.at(-1)).toBe(seen.prompts.at(-2))
  })
})
