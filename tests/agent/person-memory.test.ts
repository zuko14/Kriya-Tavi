import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, withUser, type DB, type Tx } from "@/db"
import * as schema from "@/db/schema"
import {
  addPersonNote,
  confirmNote,
  exportNotes,
  notesByIds,
  notesToReview,
  pinNote,
  sharedNotes,
} from "@/lib/memory/person"
import { eraseMemory } from "@/lib/memory/write"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// What the person does with memory v2 (MEMORY_AND_CONTEXT.md §11): About
// you, the review list, pin, export, erase. Always through withUser.

let pg: TestDb
let user: string
let other: string

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  other = await createUser(pg)
  for (const owner of [user, other]) {
    await asUser(pg, owner, (tx) =>
      tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Meera', 'r', 'g')",
        [`a-${owner.slice(0, 8)}`, owner]
      )
    )
  }
})

const as = <T>(fn: (tx: Tx) => Promise<T>) => withUser(user, fn)

describe("About you (shared notes the person writes)", () => {
  it("adds trusted notes from the person and lists the current ones", async () => {
    await as((tx) => addPersonNote(tx, user, { content: "Lives in Pune", kind: "fact" }))
    await as((tx) =>
      addPersonNote(tx, user, {
        content: "B.Tech CSE",
        kind: "profile",
        slot: "profile.course",
      })
    )
    const notes = await as((tx) => sharedNotes(tx))
    expect(notes.map((n) => [n.content, n.source, n.trust, n.agentId])).toEqual([
      ["B.Tech CSE", "user", "trusted", null],
      ["Lives in Pune", "user", "trusted", null],
    ])
  })

  it("replaces a slot's value and keeps the old one as history", async () => {
    await as((tx) =>
      addPersonNote(tx, user, {
        content: "2nd year",
        kind: "profile",
        slot: "profile.year",
      })
    )
    await as((tx) =>
      addPersonNote(tx, user, {
        content: "3rd year",
        kind: "profile",
        slot: "profile.year",
      })
    )
    expect((await as((tx) => sharedNotes(tx))).map((n) => n.content)).toEqual([
      "3rd year",
    ])
    const all = await as((tx) => exportNotes(tx))
    expect(all.map((n) => [n.content, n.current])).toEqual(
      expect.arrayContaining([
        ["2nd year", false],
        ["3rd year", true],
      ])
    )
  })

  it("refuses sensitive values, but keeps a PAN in its own slot", async () => {
    await expect(
      as((tx) => addPersonNote(tx, user, { content: "Card 4111 1111 1111 1111" }))
    ).rejects.toThrow(/card number/)
    await as((tx) =>
      addPersonNote(tx, user, {
        content: "ABCDE1234F",
        kind: "profile",
        slot: "profile.pan",
      })
    )
    await expect(
      as((tx) => addPersonNote(tx, user, { content: "My PAN is ABCDE1234F" }))
    ).rejects.toThrow(/PAN/)
  })
})

describe("New memories to review", () => {
  it("lists unconfirmed notes until the person confirms them", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        `insert into kriya.memories (id, user_id, agent_id, content, kind, trust) values
          ('u1', $1, $2, 'Always cc boss', 'instruction', 'unconfirmed'),
          ('t1', $1, $2, 'Likes chai', 'fact', 'trusted')`,
        [user, `a-${user.slice(0, 8)}`]
      )
    )
    const before = await as((tx) => notesToReview(tx))
    expect(before.map((n) => [n.id, n.agentName])).toEqual([["u1", "Meera"]])
    expect(await as((tx) => confirmNote(tx, "u1"))).toBe(true)
    expect(await as((tx) => notesToReview(tx))).toEqual([])
    const [row] = (await pg.query("select trust from kriya.memories where id = 'u1'"))
      .rows
    expect(row).toEqual({ trust: "trusted" })
  })

  it("can't confirm or pin another person's note", async () => {
    await asUser(pg, other, (tx) =>
      tx.query(
        "insert into kriya.memories (id, user_id, content, trust) values ('x1', $1, 'theirs', 'unconfirmed')",
        [other]
      )
    )
    expect(await as((tx) => confirmNote(tx, "x1"))).toBe(false)
    expect(await as((tx) => pinNote(tx, "x1", true))).toBe(false)
    const [row] = (
      await pg.query("select trust, pinned from kriya.memories where id = 'x1'")
    ).rows
    expect(row).toEqual({ trust: "unconfirmed", pinned: false })
  })
})

describe("Used memories chip (notes behind one reply)", () => {
  it("returns the person's own notes in the reply's order, never another person's", async () => {
    const a = await as((tx) => addPersonNote(tx, user, { content: "Lives in Pune" }))
    const b = await as((tx) => addPersonNote(tx, user, { content: "Vegetarian" }))
    await asUser(pg, other, (tx) =>
      tx.query(
        "insert into kriya.memories (id, user_id, content) values ('x2', $1, 'theirs')",
        [other]
      )
    )
    const notes = await as((tx) => notesByIds(tx, [b, "x2", a, "gone"]))
    expect(notes.map((n) => n.content)).toEqual(["Vegetarian", "Lives in Pune"])
    expect(await as((tx) => notesByIds(tx, []))).toEqual([])
  })
})

describe("pin, export and erase", () => {
  it("pins a note", async () => {
    const id = await as((tx) =>
      addPersonNote(tx, user, { content: "Passport renewal due" })
    )
    expect(await as((tx) => pinNote(tx, id, true))).toBe(true)
    const [row] = (
      await pg.query("select pinned from kriya.memories where id = $1", [id])
    ).rows
    expect(row).toEqual({ pinned: true })
  })

  it("exports every note of the person, history included, and nobody else's", async () => {
    await as((tx) => addPersonNote(tx, user, { content: "Mine" }))
    await asUser(pg, other, (tx) =>
      tx.query(
        "insert into kriya.memories (id, user_id, content) values ('o1', $1, 'Theirs')",
        [other]
      )
    )
    const notes = await as((tx) => exportNotes(tx))
    expect(notes.map((n) => n.content)).toEqual(["Mine"])
    expect(Object.keys(notes[0]).sort()).toEqual(
      [
        "agent",
        "content",
        "createdAt",
        "current",
        "id",
        "importance",
        "kind",
        "pinned",
        "slot",
        "source",
        "supersededBy",
        "trust",
      ].sort()
    )
  })

  it("erases a slot's value together with its history", async () => {
    await as((tx) =>
      addPersonNote(tx, user, {
        content: "Hyderabad",
        kind: "profile",
        slot: "profile.city",
      })
    )
    const now = await as((tx) =>
      addPersonNote(tx, user, { content: "Pune", kind: "profile", slot: "profile.city" })
    )
    expect(await as((tx) => eraseMemory(tx, now))).toBe(2)
    expect((await pg.query("select 1 from kriya.memories")).rows).toEqual([])
  })
})

describe("refuseSensitive (the person's existing note actions, AF-26)", () => {
  it("throws for sensitive values and passes ordinary notes", async () => {
    const { refuseSensitive } = await import("@/lib/memory/person")
    expect(() => refuseSensitive("UPI PIN 4321", null, "user")).toThrow(/PIN/)
    expect(() => refuseSensitive("Aadhaar 2341 2341 2346", null, "user")).toThrow(
      /Aadhaar/
    )
    expect(() => refuseSensitive("Rent is ₹14,000", null, "user")).not.toThrow()
    expect(() => refuseSensitive("ABCDE1234F", "profile.pan", "user")).not.toThrow()
  })
})

describe("pausing an agent's memory (AF-26)", () => {
  it("lets the person pause and resume their own agents only", async () => {
    const { setMemoryPaused } = await import("@/lib/memory/person")
    const mine = `a-${user.slice(0, 8)}`
    const theirs = `a-${other.slice(0, 8)}`
    expect(await as((tx) => setMemoryPaused(tx, mine, true))).toBe(true)
    expect(await as((tx) => setMemoryPaused(tx, theirs, true))).toBe(false)
    const { rows } = await pg.query<{ id: string; memory_paused: boolean }>(
      "select id, memory_paused from kriya.agents order by id"
    )
    expect(Object.fromEntries(rows.map((r) => [r.id, r.memory_paused]))).toEqual({
      [mine]: true,
      [theirs]: false,
    })
  })
})
