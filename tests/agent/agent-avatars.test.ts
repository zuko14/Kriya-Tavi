import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { MARK_ICONS } from "@/components/glyph"
import {
  agentGlyph,
  glyphSpec,
  joinedGlyph,
  MARK_IDS,
  MARKS,
  markForRole,
  parseGlyph,
  TONE_IDS,
} from "@/lib/glyph"
import { agentTemplates } from "@/lib/templates"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Agent avatars (lib/glyph.ts): a professional mark picked by the role unless
// the person chose one, resolved the same way everywhere an agent is shown,
// and only known marks and tones stored by the Creator's actions.

const state = { user: "" }
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: state.user }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const { createAgent, updateAgent } = await import("@/actions/agents")
const { getNavigation } = await import("@/queries/workspace")

describe("the mark a role picks", () => {
  it.each([
    ["Software engineer", "engineer"],
    ["Research analyst", "research"],
    ["Google manager", "calendar"],
    ["Executive assistant: calendar, mail and meeting prep", "calendar"],
    ["GitHub and release assistant", "github"],
    ["Accounts: bills, GST and reports", "finance"],
    ["Study partner and research guide", "study"],
    ["Content and social media", "marketing"],
    ["Proposals, emails and client work", "sales"],
    ["Copywriter for blogs", "writer"],
    ["Career and profile coach", "career"],
    ["Scholarships, internships and admissions watcher", "watcher"],
    ["Hiring and team", "hiring"],
    ["Research and trends for creators", "creator"],
    ["Customer support lead", "support"],
    ["Legal and contracts", "legal"],
    ["", "assistant"],
    ["Something unusual", "assistant"],
  ])("%s → %s", (role, mark) => expect(markForRole(role)).toBe(mark))

  it("matches at the start of a word, not inside one", () => {
    expect(markForRole("Accounting help")).toBe("finance")
    // "ui" and "ads" inside other words don't count
    expect(markForRole("Quietly reads")).toBe("assistant")
  })

  it("gives every template a mark of its own kind, never the general one", () => {
    for (const template of agentTemplates)
      expect(markForRole(template.role), template.role).not.toBe("assistant")
  })
})

describe("stored values", () => {
  it("a chosen avatar is <mark>:<tone>, both known", () => {
    expect(parseGlyph("engineer:indigo")).toEqual({ mark: "engineer", tone: "indigo" })
    for (const bad of [
      "engineer",
      "engineer:neon",
      "rocketship:indigo",
      "engineer:indigo:x",
      "x7Fk2Pq9aZ",
      "",
      null,
      undefined,
      "__proto__:indigo",
      "engineer:constructor",
    ])
      expect(parseGlyph(bad as string), String(bad)).toBeNull()
  })

  it("the person's choice wins; anything else follows the role", () => {
    expect(agentGlyph({ glyph: "legal:garnet", role: "Software engineer" })).toBe(
      "legal:garnet"
    )
    expect(agentGlyph({ glyph: "x7Fk2Pq9aZ", role: "Software engineer" })).toBe(
      "engineer:indigo"
    )
    expect(agentGlyph({ glyph: null, role: null })).toBe("assistant:teal")
    expect(joinedGlyph(null, null)).toBeNull()
    expect(joinedGlyph("x7Fk2Pq9aZ", "Research analyst")).toBe("research:teal")
  })

  it("the renderer never draws something random for an unresolved value", () => {
    expect(glyphSpec("x7Fk2Pq9aZ")).toEqual(glyphSpec("anything else"))
  })

  it("every mark has a drawn icon, a label and a known tone", () => {
    expect(new Set(MARK_IDS).size).toBe(MARKS.length)
    for (const mark of MARKS) {
      expect(MARK_ICONS[mark.id], mark.id).toBeTruthy()
      expect(TONE_IDS).toContain(mark.tone)
      // A stored value has to fit agents.glyph (32 characters)
      for (const tone of TONE_IDS) expect(`${mark.id}:${tone}`.length).toBeLessThan(33)
    }
  })

  it("every place that shows an agent resolves its glyph first", () => {
    // Files that read an agent's stored glyph for the UI; each must call agentGlyph
    const producers = [
      "queries/workspace.ts",
      "queries/inbox.ts",
      "app/api/events/route.ts",
      "lib/agent/run-task.ts",
      "components/thread/thread-page.tsx",
      "app/(workspace)/a/[agentId]/page.tsx",
      "app/(workspace)/s/[squadId]/page.tsx",
    ]
    for (const file of producers) {
      const text = fs.readFileSync(path.join(process.cwd(), file), "utf8")
      expect(text, file).toMatch(/\b(agentGlyph|joinedGlyph)\b/)
      // No raw stored glyph handed on as it is
      expect(text, file).not.toMatch(/glyphs?: \[?[a-z!.]*agent!?\.glyph\b/)
    }
  })
})

let pg: TestDb
let alice: string

const made = async (input: Record<string, unknown> = {}) => {
  const result = await createAgent({
    name: "Arjun",
    role: "Software engineer",
    instructions: "",
    model: "",
    ...input,
  } as never)
  if ("error" in result) throw new Error(result.error)
  return result.agent
}
const navAgent = async (id: string) =>
  (await getNavigation(alice)).agents.find((a) => a.id === id)!

describe("through the Creator's actions", () => {
  beforeEach(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    alice = await createUser(pg)
    state.user = alice
  })

  it("a new agent follows its role, and keeps following it when the role changes", async () => {
    const agent = await made()
    expect(await navAgent(agent.id)).toMatchObject({
      glyph: "engineer:indigo",
      glyphChoice: null,
    })
    await updateAgent(agent.id, { name: "Arjun", role: "Research analyst" } as never)
    expect((await navAgent(agent.id)).glyph).toBe("research:teal")
  })

  it("a chosen avatar is kept, and 'auto' goes back to the role", async () => {
    const agent = await made({ glyph: "legal:plum" })
    expect(await navAgent(agent.id)).toMatchObject({
      glyph: "legal:plum",
      glyphChoice: "legal:plum",
    })
    await updateAgent(agent.id, {
      name: "Arjun",
      role: "Software engineer",
      glyph: "auto",
    } as never)
    expect(await navAgent(agent.id)).toMatchObject({
      glyph: "engineer:indigo",
      glyphChoice: null,
    })
  })

  it("an agent saved from an older page (a random seed) follows its role", async () => {
    const agent = await made({ glyph: "x7Fk2Pq9aZ" })
    expect((await navAgent(agent.id)).glyph).toBe("engineer:indigo")
  })

  it("refuses a value that isn't a known avatar", async () => {
    for (const glyph of ["engineer:neon", "<svg>", "rocket:indigo"]) {
      const result = await createAgent({
        name: "X",
        role: "Software engineer",
        instructions: "",
        model: "",
        glyph,
      } as never)
      expect(result, glyph).toEqual({ error: "Choose an avatar from the list." })
    }
  })
})
