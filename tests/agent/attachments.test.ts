import { drizzle } from "drizzle-orm/pglite"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { enqueueTurn, TurnError } from "@/lib/agent/queue"
import { withAttachmentNotes } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// Files attached from the composer (agents.files): only the person's own
// files that passed the upload check ride on a message, by id; the server
// records each name itself, and the model is told to read them with
// file_read. Messages without files reach the model unchanged.

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))

let pg: TestDb
let alice: string
let bob: string

async function file(user: string, name: string, status = "extracted") {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.files (user_id, name, mime, size_bytes, origin, status, sha256)
     values ($1, $2, 'application/pdf', 100, 'upload', $3,
             case when $3 in ('pending', 'rejected') then null else repeat('a', 64) end)
     returning id`,
    [user, name, status]
  )
  return rows[0].id
}

const turn = (attachments: string[], text = "What does this say?", id = "m1") =>
  enqueueTurn({
    userId: alice,
    threadId: "t1",
    message: { id, role: "user", parts: [{ type: "text", text }] } as KriyaMessage,
    idempotencyKey: `k-${id}`,
    attachments,
  })

const saved = async (id: string) =>
  (
    await pg.query<{ metadata: KriyaMessage["metadata"] }>(
      "select metadata from kriya.messages where id = $1",
      [id]
    )
  ).rows[0]?.metadata

const filesSwitch = (value: "on" | "off") => {
  process.env.KRIYA_AGENTS_FILES = value
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

// One database for the file (a fresh one per case loads the whole suite);
// each case starts from no files, messages or tasks
beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  alice = await createUser(pg)
  bob = await createUser(pg)
  await asUser(pg, alice, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'r', 'g')",
      [alice]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [alice]
    )
  })
})

beforeEach(async () => {
  filesSwitch("on")
  await pg.query("delete from kriya.tasks")
  await pg.query("delete from kriya.messages")
  await pg.query("delete from kriya.files")
  await pg.query("update kriya.threads set title = null where id = 't1'")
})

describe("attachments on a turn", () => {
  it("records the person's own checked files with the server's names", async () => {
    const pdf = await file(alice, "invoice.pdf")
    const fresh = await file(alice, "scan.pdf", "ready")
    await turn([pdf, fresh, pdf])
    expect((await saved("m1"))?.attachments).toEqual([
      { id: pdf, name: "invoice.pdf", mime: "application/pdf" },
      { id: fresh, name: "scan.pdf", mime: "application/pdf" },
    ])
  })

  it("files alone are a message; the thread is titled by their names", async () => {
    const pdf = await file(alice, "lease.pdf")
    await turn([pdf], "", "m2")
    const { rows } = await pg.query<{ title: string }>(
      "select title from kriya.threads where id = 't1'"
    )
    expect(rows[0].title).toBe("lease.pdf")
  })

  it("refuses another person's file, an unchecked one, too many, or files switched off", async () => {
    const theirs = await file(bob, "secret.pdf")
    const pending = await file(alice, "half.pdf", "pending")
    const rejected = await file(alice, "bad.pdf", "rejected")
    for (const ids of [[theirs], [pending], [rejected]]) {
      const error = await turn(ids).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TurnError)
      expect((error as TurnError).code).toBe("bad_attachment")
    }
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => file(alice, `${n}.pdf`)))
    await expect(turn(six)).rejects.toThrow(/at most 5/)
    filesSwitch("off")
    await expect(turn([six[0]])).rejects.toThrow(/aren't available/)
    // Nothing was saved for any refused turn
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.messages"
    )
    expect(rows[0].n).toBe(0)
  })

  it("without attachments the message is exactly as before", async () => {
    await turn([], "Hello", "m3")
    expect(await saved("m3")).toEqual({})
  })
})

describe("what the model reads", () => {
  it("adds a note naming each file to messages with files, and touches nothing else", () => {
    const plain: KriyaMessage = {
      id: "a",
      role: "user",
      parts: [{ type: "text", text: "Hi" }],
    }
    const withFiles: KriyaMessage = {
      id: "b",
      role: "user",
      parts: [{ type: "text", text: "Summarise" }],
      metadata: {
        attachments: [
          {
            id: "11111111-2222-4333-8444-555555555555",
            name: "q3\nreport.pdf",
            mime: "application/pdf",
          },
        ],
      },
    }
    const [a, b] = withAttachmentNotes([plain, withFiles])
    expect(a).toBe(plain)
    expect(b.parts).toHaveLength(2)
    const note = (b.parts[1] as { text: string }).text
    expect(note).toContain("file_read")
    expect(note).toContain("file id 11111111-2222-4333-8444-555555555555")
    // A name can't break out onto lines of its own
    expect(note).toContain("q3 report.pdf")
    expect(withFiles.parts).toHaveLength(1)
  })
})
