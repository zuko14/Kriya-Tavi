import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, withUser, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createTeam } from "@/lib/teams"
import { packFor } from "@/lib/templates"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// "Meet your team" (A2): the chosen agents of a role pack, their squad and
// its thread, and the person's answers as "About you" notes, all in one
// withUser transaction that respects the plan's agent limit.

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
})

const make = (input: Partial<Parameters<typeof createTeam>[2]> = {}) =>
  withUser(user, (tx) =>
    createTeam(tx, user, {
      useCase: "student",
      members: ["Vidya", "Disha", "Khoj"],
      about: [],
      maxAgents: 3,
      ...input,
    })
  )

const count = async (table: string) =>
  (await pg.query<{ n: number }>(`select count(*)::int as n from kriya.${table}`)).rows[0]
    .n

describe("createTeam", () => {
  it("creates the chosen agents, their squad and its thread", async () => {
    const destination = await make()
    const { rows: agents } = await pg.query<{
      name: string
      role: string
      user_id: string
    }>("select name, role, user_id from kriya.agents order by created_at, name")
    expect(agents.map((a) => a.name).sort()).toEqual(["Disha", "Khoj", "Vidya"])
    expect(agents.every((a) => a.user_id === user)).toBe(true)
    const disha = packFor("student").members.find((m) => m.name === "Disha")!
    expect(agents.find((a) => a.name === "Disha")?.role).toBe(disha.role)

    const { rows: squads } = await pg.query<{ id: string; name: string }>(
      "select id, name from kriya.squads"
    )
    expect(squads).toEqual([{ id: expect.any(String), name: "Vidya team" }])
    const { rows: members } = await pg.query<{ name: string }>(
      "select a.name from kriya.squad_members m join kriya.agents a on a.id = m.agent_id order by m.position"
    )
    expect(members.map((m) => m.name)).toEqual(["Vidya", "Disha", "Khoj"])
    const { rows: threads } = await pg.query<{ id: string; squad_id: string }>(
      "select id, squad_id from kriya.threads"
    )
    expect(threads).toHaveLength(1)
    expect(destination).toBe(`/s/${squads[0].id}/${threads[0].id}`)
  })

  it("one chosen agent gets its own thread, no squad", async () => {
    const destination = await make({ members: ["Disha"] })
    expect(await count("squads")).toBe(0)
    const { rows } = await pg.query<{ id: string; agent_id: string }>(
      "select id, agent_id from kriya.threads"
    )
    expect(destination).toBe(`/a/${rows[0].agent_id}/${rows[0].id}`)
  })

  it("refuses more agents than the plan allows, and writes nothing", async () => {
    await expect(
      make({ useCase: "founder", members: ["Lekha", "Saathi", "Meera", "Kabir"] })
    ).rejects.toThrow(/3 agents/)
    expect(await count("agents")).toBe(0)
    expect(await count("squads")).toBe(0)
    expect(await count("threads")).toBe(0)
  })

  it("accepts only the pack's own agents, once each", async () => {
    await expect(make({ members: ["Vidya", "Lekha"] })).rejects.toThrow(/team/)
    await expect(make({ members: [] })).rejects.toThrow(/at least one/)
    await make({ members: ["Vidya", "Vidya", "Disha"] })
    expect(await count("agents")).toBe(2)
  })

  it("a person who already has agents gets no team", async () => {
    await asUser(pg, user, (tx) =>
      tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('mine', $1, 'Own', 'r', 'g')",
        [user]
      )
    )
    expect(await make()).toBe("/home")
    expect(await count("agents")).toBe(1)
  })

  it("saves the person's answers as trusted, shared 'About you' notes", async () => {
    await make({
      about: [
        { slot: "profile.course", content: "B.Tech CSE, 3rd year" },
        { slot: "profile.city", content: "  " },
      ],
    })
    const { rows } = await pg.query(
      "select content, kind, slot, source, trust, agent_id, user_id from kriya.memories"
    )
    expect(rows).toEqual([
      {
        content: "B.Tech CSE, 3rd year",
        kind: "profile",
        slot: "profile.course",
        source: "user",
        trust: "trusted",
        agent_id: null,
        user_id: user,
      },
    ])
  })

  it("accepts only the pack's own slots, and refuses sensitive values with nothing written", async () => {
    await expect(
      make({ about: [{ slot: "profile.bank", content: "SBI" }] })
    ).rejects.toThrow(/slot/)
    await expect(
      // Fictional, but with a valid Verhoeff check digit (A1's detector)
      make({
        about: [{ slot: "profile.course", content: "My Aadhaar is 2345 6789 0124" }],
      })
    ).rejects.toThrow(/Not saved/)
    expect(await count("agents")).toBe(0)
    expect(await count("memories")).toBe(0)
  })

  it("never touches another person's data", async () => {
    await asUser(pg, other, (tx) =>
      tx.query(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ('theirs', $1, 'T', 'r', 'g')",
        [other]
      )
    )
    // Their agent doesn't count against this person's limit or block the team
    expect(await make()).toMatch(/^\/s\//)
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.agents where user_id = $1",
      [other]
    )
    expect(rows[0].n).toBe(1)
  })
})
