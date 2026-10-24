import fs from "node:fs"
import path from "node:path"

import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { rowsOf, setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { TOOL_CLASSES } from "@/lib/agent/policy"
import { enqueueTurn } from "@/lib/agent/queue"
import { runTask } from "@/lib/agent/run-task"
import type { KriyaMessage } from "@/lib/agent/tools"
import { readSkill } from "@/lib/skill-engine"
import { CATALOG, CATALOG_V2, checkSkillPrefs, resolveSkills } from "@/lib/skill-library"
import { loadSkillV2, SKILLS_V2_ROOT } from "@/lib/skills-v2"
import { SKILL_MANIFESTS_V2 } from "@/skills"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// Skills v2 (track N, N8, ND-14): a Unicode-aware matcher, Hindi, Telugu and
// romanised keywords, two new curated skills. All of it only with
// next.skillsV2 on; off is today's matcher and CATALOG exactly.

vi.mock("server-only", () => ({}))

const prompts: string[] = []
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        prompts.push(
          options.prompt
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n")
        )
        const usage = {
          inputTokens: {
            total: 10,
            noCache: 10,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Done." },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              },
            ] as never[],
          }),
        }
      },
    }),
}))

const ALL_TOOLS = Object.keys(TOOL_CLASSES).concat("propose_call")
const BIG = { skills: 30, chars: 1_000_000 }
const load = (id: string, version: string) => loadSkillV2(id, version)

const resolve = (ask: string, over: Partial<Parameters<typeof resolveSkills>[0]> = {}) =>
  resolveSkills({
    prefs: { auto: true, on: CATALOG_V2.filter((s) => !s.required).map((s) => s.id) },
    role: "r",
    ask,
    tools: ALL_TOOLS,
    load,
    limits: BIG,
    catalog: CATALOG_V2,
    ...over,
  })
const ids = (r: ReturnType<typeof resolveSkills>) => r.active.map((a) => a.id)

describe("the Unicode matcher (NT-SKL-01)", () => {
  const gst = (ask: string, unicode: boolean) =>
    ids(resolve(ask, { catalog: CATALOG_V2, unicode })).includes("gst-invoices")

  it("matches whole words only, in any script", () => {
    expect(gst("मेरा बिल भेजो", true)).toBe(true)
    expect(gst("बिलकुल सही है", true)).toBe(false)
    expect(gst("ఈ బిల్లు ఎంత?", true)).toBe(true)
    // Combining marks count as part of the word
    expect(gst("बिल्कुल सही", true)).toBe(false)
  })

  it("leaves today's matcher blind to Hindi and Telugu", () => {
    expect(gst("मेरा बिल भेजो", false)).toBe(false)
    expect(gst("ఈ బిల్లు ఎంత?", false)).toBe(false)
  })

  it("matches the same dotted letters typed in either Unicode form", () => {
    const docs = (ask: string) =>
      ids(resolve(ask, { unicode: true })).includes("indian-documents-reading")
    expect(docs("यह फ़ाइल पढ़ो")).toBe(true) // precomposed U+095E
    expect(docs("यह फ़ाइल पढ़ो")).toBe(true) // letter + nukta
  })
})

describe("what stays as it is with the switch off (NT-SKL-03)", () => {
  it("every existing eval resolves the same with and without the Unicode matcher", () => {
    for (const skill of CATALOG) {
      for (const { ask } of skill.evals) {
        const base = {
          prefs: { auto: true, on: [skill.id] },
          role: "r",
          ask,
          tools: ALL_TOOLS,
          load: (id: string, v: string) => readSkill(id, v),
        }
        const old = resolveSkills(base)
        const next = resolveSkills({ ...base, unicode: true })
        expect(ids(next), `${skill.id}: "${ask}"`).toEqual(ids(old))
      }
    }
  })

  it("CATALOG is untouched: no v2 id, no keywordsIntl read", () => {
    const v2 = new Set((SKILL_MANIFESTS_V2 as { id: string }[]).map((m) => m.id))
    expect(CATALOG.some((s) => v2.has(s.id))).toBe(false)
    expect(CATALOG_V2.map((s) => s.id).sort()).toEqual(
      [...CATALOG.map((s) => s.id), ...v2].sort()
    )
    // The default call ignores keywordsIntl even for a skill that has them
    expect(ids(resolve("मेरा बिल भेजो", { catalog: CATALOG_V2 }))).not.toContain(
      "gst-invoices"
    )
  })
})

describe("only the person's words pick a skill (NT-SKL-02)", () => {
  it("an empty ask (a crew's join, a watcher run) activates no keyword skill", () => {
    const got = ids(resolve("", { unicode: true }))
    for (const id of ["gst-invoices", "calendar-operations", "delivery-proof"])
      expect(got).not.toContain(id)
  })
})

describe("the v2 skills (NT-SKL-04)", () => {
  const v2 = CATALOG_V2.filter((s) => !CATALOG.some((c) => c.id === s.id))

  it("are the two named in ND-14, each parsed and listed once", () => {
    expect(v2.map((s) => s.id).sort()).toEqual([
      "delivery-proof",
      "indian-documents-reading",
    ])
    expect(fs.readdirSync(SKILLS_V2_ROOT).sort()).toEqual([
      "delivery-proof",
      "indian-documents-reading",
    ])
  })

  it("load, fit their size limit, name only real tools and declare each one", () => {
    for (const skill of v2) {
      const text = readSkill(skill.id, skill.version, SKILLS_V2_ROOT, CATALOG_V2)
      expect(text.length).toBeGreaterThan(200)
      expect(text.length).toBeLessThanOrEqual(skill.limits.maxChars)
      const declared = [...skill.tools.all, ...skill.tools.any, ...skill.tools.uses]
      for (const tool of declared)
        expect(ALL_TOOLS, `${skill.id}: ${tool}`).toContain(tool)
      for (const [, tool] of text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
        expect(ALL_TOOLS, `${skill.id} mentions ${tool}`).toContain(tool)
        expect(declared, `${skill.id} doesn't declare ${tool}`).toContain(tool)
      }
      expect(skill.evals.some((e) => e.expect === "activate")).toBe(true)
      expect(skill.evals.some((e) => e.expect === "skip")).toBe(true)
      // Only text: nothing else is in the directory
      expect(fs.readdirSync(path.join(SKILLS_V2_ROOT, skill.id)).sort()).toEqual([
        "SKILL.md",
        "kriya.json",
      ])
    }
  })

  it("activate, or not, on their own evals with the Unicode matcher", () => {
    for (const skill of v2) {
      for (const { ask, expect: want } of skill.evals) {
        const got = ids(
          resolve(ask, { prefs: { auto: true, on: [skill.id] }, unicode: true })
        ).includes(skill.id)
        expect(got ? "activate" : "skip", `${skill.id}: "${ask}"`).toBe(want)
      }
    }
  })

  it("add no tool and need file_read only where they read files", () => {
    const docs = v2.find((s) => s.id === "indian-documents-reading")!
    expect(docs.tools.all).toEqual(["file_read"])
    expect(v2.find((s) => s.id === "delivery-proof")!.tools).toEqual({
      all: [],
      any: [],
      uses: [],
    })
    // Without file_read on the belt the document skill is skipped, not loaded
    const r = resolve("PDF uploaded", {
      unicode: true,
      tools: ALL_TOOLS.filter((t) => t !== "file_read"),
    })
    expect(ids(r)).not.toContain("indian-documents-reading")
    expect(r.skipped.find((s) => s.id === "indian-documents-reading")?.reason).toMatch(
      /file_read/
    )
  })
})

describe("saved assignments (NT-SKL-05)", () => {
  it("accept v2 ids only against CATALOG_V2", () => {
    const input = { auto: true, on: ["delivery-proof"] }
    expect(checkSkillPrefs(input, CATALOG_V2).on).toEqual(["delivery-proof"])
    expect(() => checkSkillPrefs(input, CATALOG)).toThrow(/isn't a Kriya skill/)
    expect(() => checkSkillPrefs(input)).toThrow(/isn't a Kriya skill/)
  })
})

// 40 requests in English, Hindi, Telugu and romanised Hindi, with the skills
// (of the four that can match) each should and shouldn't load. No model.
const GST = "gst-invoices"
const CAL = "calendar-operations"
const PROOF = "delivery-proof"
const DOCS = "indian-documents-reading"
const FOUR = [GST, CAL, PROOF, DOCS]
const ASKS: [string, string[]][] = [
  ["मेरा बिल भेजो", [GST]],
  ["इस चालान का जीएसटी कितना है?", [GST]],
  ["कल की मीटिंग कैलेंडर में डालो", [CAL]],
  ["आज का खर्च जोड़ दो", [GST]],
  ["मैंने पीडीएफ अपलोड किया है, पढ़कर बताओ", [DOCS]],
  ["क्या मेल भेज दिया? हो गया क्या?", [PROOF]],
  ["बिलकुल सही है, धन्यवाद", []],
  ["मुझे एक कविता सुनाओ", []],
  ["बैठक का समय बताओ", [CAL]],
  ["सबूत दिखाओ कि काम पूरा हुआ", [PROOF]],
  ["ఈ బిల్లు ఎంత?", [GST]],
  ["రేపటి మీటింగ్ క్యాలెండర్‌లో పెట్టు", [CAL]],
  ["ఈ ఫైల్ చదివి చెప్పు", [DOCS]],
  ["ఖర్చు వివరాలు చెప్పు", [GST]],
  ["అయిపోయిందా? రుజువు చూపించు", [PROOF]],
  ["ఈ రోజు వాతావరణం ఎలా ఉంది?", []],
  ["జీఎస్టీ ఇన్వాయిస్ తయారు చెయ్యి", [GST]],
  ["సమావేశం ఎప్పుడు?", [CAL]],
  ["నాకు ఒక కథ చెప్పు", []],
  ["రసీదు ఫైల్ అప్‌లోడ్ చేశాను", [GST, DOCS]],
  ["kharcha ka hisaab bhejo", [GST]],
  ["kal meeting hai, calendar mein daalo", [CAL]],
  ["ho gaya? pakka batao", [PROOF]],
  ["mulaqat ka time kya hai", [CAL]],
  ["aaj mausam kaisa hai", []],
  ["invoice bhejo", [GST]],
  ["uploaded pdf padh ke total batao", [DOCS]],
  ["did it work? send proof", [PROOF]],
  ["tell me a joke", []],
  ["kal ka plan batao", []],
  ["बिलकुल नहीं", []],
  ["billion dollar market size", []],
  ["milna hai kya", [CAL]],
  ["pdfs of my notes", [DOCS]],
  ["Proofreading my essay", []],
  ["confirmation email", []],
  ["Can you confirm the meeting?", [CAL, PROOF]],
  ["मेरी पीडीएफ़ फ़ाइल देखो", [DOCS]],
  ["ఈ రోజు మీటింగ్ లేదు", [CAL]],
  ["thanks, bye", []],
]

describe("Indian-language requests (AS-SKL-ML)", () => {
  it("has 40 requests", () => expect(ASKS).toHaveLength(40))

  it.each(ASKS)("%s", (ask, want) => {
    const got = ids(resolve(ask, { unicode: true })).filter((id) => FOUR.includes(id))
    expect(got.sort()).toEqual([...want].sort())
  })

  it("has no false activation: nothing the table marks as unrelated loads a skill", () => {
    for (const [ask, want] of ASKS.filter(([, want]) => want.length === 0)) {
      expect(
        ids(resolve(ask, { unicode: true })).filter((id) => FOUR.includes(id))
      ).toEqual(want)
    }
  })
})

/* ───────────────────────────── the runner ─────────────────────────── */

let pg: TestDb
let user: string
const reset = () =>
  ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)

async function turn(text: string) {
  await enqueueTurn({
    userId: user,
    threadId: "t1",
    message: {
      id: `m${Math.random()}`,
      role: "user",
      parts: [{ type: "text", text }],
    } as KriyaMessage,
  })
  const db = drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  const id = rowsOf<{ id: string }>(
    await db.execute(sql`select id from kriya.claim_task('w1', 30)`)
  )[0]?.id
  const { rows } = await pg.query<Record<string, unknown>>(
    "select * from kriya.tasks where id = $1",
    [id]
  )
  const task = Object.fromEntries(
    Object.entries(rows[0]).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value,
    ])
  ) as unknown as schema.Task
  await runTask(task, {
    workerId: "w1",
    leaseSeconds: 30,
    shutdown: new AbortController().signal,
  })
}

beforeEach(async () => {
  prompts.length = 0
  process.env.OPENROUTER_DEFAULT_MODEL = "test/budget-model"
  process.env.KRIYA_AGENTS_SKILL_LIBRARY = "on"
  delete process.env.KRIYA_NEXT_SKILLS_V2
  reset()
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'Research analyst', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
})
afterEach(() => {
  delete process.env.KRIYA_AGENTS_SKILL_LIBRARY
  delete process.env.KRIYA_NEXT_SKILLS_V2
  reset()
})

describe("next.skillsV2 in the runner", () => {
  it("off: the prompt is the same unset or off, and a Hindi request loads no v2 skill", async () => {
    await turn("हो गया क्या?")
    process.env.KRIYA_NEXT_SKILLS_V2 = "off"
    reset()
    await turn("हो गया क्या?")
    expect(prompts[1]).toBe(prompts[0])
    expect(prompts[0]).not.toContain("Delivery proof")
  })

  it("on: the same request loads the v2 skill, from its own directory", async () => {
    process.env.KRIYA_NEXT_SKILLS_V2 = "on"
    reset()
    await turn("हो गया क्या?")
    expect(prompts[0]).toContain("## Delivery proof (v1.0.0)")
    // Today's skills still load the same way
    expect(prompts[0]).toContain("# Skills")
  })
})
