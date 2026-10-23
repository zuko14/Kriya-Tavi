import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { getPlan } from "@/lib/entitlements"
import { skillOptions } from "@/queries/skills"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// What the Creator's Skills section shows (queries/skills.ts): nothing with
// the switch off; with it on, each skill's real availability for this
// person, its prerequisites when missing, its code-computed risk, and the
// owner's kill switch.

let pg: TestDb
let user: string

const reset = () => {
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}
const options = async () => skillOptions(user, await getPlan(user))
const find = async (id: string) => (await options())!.find((o) => o.id === id)!

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  process.env.KRIYA_AGENTS_SKILL_LIBRARY = "on"
  reset()
})
afterEach(() => {
  for (const key of [
    "KRIYA_AGENTS_SKILL_LIBRARY",
    "KRIYA_SKILLS_DISABLED",
    "FIRECRAWL_API_KEY",
    "KRIYA_AGENTS_LEDGER",
  ])
    delete process.env[key]
  reset()
})

describe("the Creator's skill options", () => {
  it("are absent with the switch off, so the Creator is unchanged", async () => {
    delete process.env.KRIYA_AGENTS_SKILL_LIBRARY
    reset()
    expect(await options()).toBeNull()
  })

  it("show what's missing and the prerequisite to fix it", async () => {
    const research = await find("research-verification")
    expect(research.missing).toEqual(["web_search or web_fetch"])
    expect(research.prerequisites).toEqual(["Web access, set up by Kriya"])
    const gst = await find("gst-invoices")
    expect(gst.missing).toContain("ledger_list")
    const planning = await find("task-planning")
    expect(planning).toMatchObject({ missing: [], prerequisites: [], risk: "R0" })
  })

  it("show a skill as available once its tools are", async () => {
    process.env.FIRECRAWL_API_KEY = "test-key"
    await pg.query("update kriya.plans set ledger_enabled = true")
    process.env.KRIYA_AGENTS_LEDGER = "on"
    reset()
    expect((await find("research-verification")).missing).toEqual([])
    expect((await find("gst-invoices")).missing).toEqual([])
  })

  it("list required skills, risk from code and the owner's kill switch", async () => {
    process.env.KRIYA_SKILLS_DISABLED = "github-workflow"
    reset()
    const all = (await options())!
    expect(
      all
        .filter((o) => o.required)
        .map((o) => o.id)
        .sort()
    ).toEqual(["security-untrusted-content", "verification-before-completion"])
    const github = all.find((o) => o.id === "github-workflow")!
    expect(github).toMatchObject({ offByKriya: true, risk: "R4" })
    expect(github.approvals).toEqual(
      expect.arrayContaining(["github_comment", "github_open_pr"])
    )
    expect(github.source).toBe("Kriya")
    expect((await find("task-planning")).source).toBe("Superpowers 6.4.2 (MIT)")
  })
})
