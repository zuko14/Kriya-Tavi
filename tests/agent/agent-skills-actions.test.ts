import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// The Creator's Skills section through the real actions (actions/agents.ts):
// assignments persist and reload, only known curated skills are accepted,
// and another person's agent can't be changed.

const state = { user: "" }
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: state.user }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const { createAgent, updateAgent } = await import("@/actions/agents")
const { getNavigation } = await import("@/queries/workspace")

let pg: TestDb
let alice: string
let bob: string

// The created agent, or the test fails with the returned error
const made = async (input: unknown) => {
  const result = await createAgent(input as never)
  if ("error" in result) throw new Error(result.error)
  return result
}

const values = (skills?: unknown) => ({
  name: "Hisaab",
  role: "Accounts: bills, GST and reports",
  instructions: "",
  model: "",
  ...(skills !== undefined && { skills }),
})

beforeEach(async () => {
  process.env.KRIYA_AGENTS_SKILL_LIBRARY = "on"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  state.user = alice
})

describe("agent skills through the Creator's actions", () => {
  it("saves the chosen skills and restores them on reload", async () => {
    const { agent } = await made(
      values({ auto: true, on: ["gst-invoices", "structured-data"] })
    )
    const nav = await getNavigation(alice)
    expect(nav.agents.find((a) => a.id === agent.id)?.skills).toEqual({
      auto: true,
      on: ["gst-invoices", "structured-data"],
    })
    await updateAgent(agent.id, values({ auto: false, on: ["task-planning"] }) as never)
    const after = await getNavigation(alice)
    expect(after.agents[0].skills).toEqual({ auto: false, on: ["task-planning"] })
  })

  it("an agent saved without the Skills section keeps null (role defaults)", async () => {
    const { agent } = await made(values())
    expect(agent.skills).toBeNull()
    await updateAgent(agent.id, { ...values(), name: "Renamed" } as never)
    const { rows } = await pg.query<{ skills: unknown }>(
      "select skills from kriya.agents where id = $1",
      [agent.id]
    )
    expect(rows[0].skills).toBeNull()
  })

  it("rejects unknown, duplicated and malformed assignments without saving", async () => {
    // Returned, not thrown: production hides a thrown action's message
    expect(
      await createAgent(values({ auto: true, on: ["run-shell-commands"] }) as never)
    ).toEqual({ error: expect.stringMatching(/isn't a Kriya skill/) })
    expect(
      await createAgent(
        values({ auto: true, on: ["task-planning", "task-planning"] }) as never
      )
    ).toEqual({ error: expect.stringMatching(/twice/) })
    expect(
      await createAgent(
        values({ auto: true, on: [], grant: ["github_comment"] }) as never
      )
    ).toEqual({ error: expect.any(String) })
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.agents"
    )
    expect(rows[0].n).toBe(0)
  })

  it("with the switch off the server ignores skills, whatever is sent", async () => {
    delete process.env.KRIYA_AGENTS_SKILL_LIBRARY
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    const { agent } = await made(values({ auto: false, on: ["task-planning"] }))
    expect(agent.skills).toBeNull()
  })

  it("can't change another person's agent's skills", async () => {
    const { agent } = await made(values({ auto: true, on: [] }))
    state.user = bob
    expect(
      await updateAgent(
        agent.id,
        values({ auto: false, on: ["github-workflow"] }) as never
      )
    ).toEqual({ error: "Agent not found" })
    const { rows } = await pg.query<{ skills: unknown }>(
      "select skills from kriya.agents where id = $1",
      [agent.id]
    )
    expect(rows[0].skills).toEqual({ auto: true, on: [] })
  })
})

describe("errors a person can act on come back as text (React error #441)", () => {
  it("says the plan's agent limit instead of throwing", async () => {
    const { getPlan } = await import("@/lib/entitlements")
    const { maxAgents } = await getPlan(alice)
    for (let i = 0; i < maxAgents; i++) await made(values())
    expect(await createAgent(values() as never)).toEqual({
      error: expect.stringMatching(/plan includes \d+ agents/),
    })
  })

  it("returns the form's own message for invalid input", async () => {
    const result = await createAgent({ ...values(), name: "" } as never)
    expect(result).toEqual({ error: expect.any(String) })
  })

  it("an unexpected failure still throws, so database text never reaches the browser", async () => {
    await pg.query("alter table kriya.agents rename column name to name_gone")
    await expect(createAgent(values() as never)).rejects.toThrow()
  })
})
