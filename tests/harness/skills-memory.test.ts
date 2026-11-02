import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// H7 (HD-10): the device agent's skills and memory. Skills follow the
// cloud's catalogue rules with the device's belt (no Kriya tools); memory
// is the device agent's notes (its own and shared), and a note saved from a
// device is always unconfirmed (HT-API-07; memory quarantine).

vi.mock("server-only", () => ({}))

import * as skillBody from "@/app/api/harness/v1/skills/[id]/[version]/route"
import * as skills from "@/app/api/harness/v1/skills/route"
import * as memory from "@/app/api/harness/v1/memory/route"
import * as search from "@/app/api/harness/v1/memory/search/route"
import {
  ErrorResponse,
  MemorySaveResponse,
  MemorySearchResponse,
  SkillsResponse,
} from "@/lib/harness/contract"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let newUser: () => Promise<string>

// Every setting this suite touches, so none leaks from one test into the next
const ON = {
  KRIYA_AGENTS_SKILL_LIBRARY: "on",
  KRIYA_AGENTS_MEMORY_V2: "on",
  KRIYA_SKILLS_DISABLED: undefined,
  KRIYA_SKILLS_PINS: undefined,
  KRIYA_NEXT_SKILL_STUDIO: undefined,
  KRIYA_NEXT_SKILLS_V2: undefined,
}
const STUDIO = "my-abcdefghij"

async function person(agent = true) {
  const user = await newUser()
  const device = await deviceFor(pg, user)
  const agentId = `ag-${device.deviceId.slice(0, 8)}`
  if (agent) {
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph, skills) values ($1, $2, 'Arjun', 'engineer', 'g', $3)",
      [
        agentId,
        user,
        JSON.stringify({
          auto: true,
          on: ["task-planning", "debugging-recovery", "calendar-operations", STUDIO],
        }),
      ]
    )
    await pg.query("update kriya.harness_devices set agent_id = $1 where id = $2", [
      agentId,
      device.deviceId,
    ])
  }
  return { user, agentId, ...device }
}

async function studioSkill(user: string) {
  await pg.query(
    `insert into kriya.user_skills (id, user_id, status, approved_at, intent, name, description, body, manifest)
     values ($1, $2, 'active', now(), 'plan family dinners', 'Dinner planner', 'Plans dinners around allergies', $3, $4)`,
    [
      STUDIO,
      user,
      // The table's check wants a real body (at least 300 characters)
      "Ask about allergies first. A guest with an allergy changes the whole menu. " +
        "List each guest, what they can't eat and why, then plan the dishes around the strictest need. ".repeat(
          4
        ),
      JSON.stringify({
        keywords: ["dinner"],
        categories: ["home"],
        tools: { all: [], any: [], uses: [] },
        verification: "Each guest's allergy is named in the plan.",
        evals: [],
      }),
    ]
  )
}

const list = (token: string, etag?: string) => {
  const request = call("GET", "/skills", { token })
  if (etag) request.headers.set("if-none-match", etag)
  return skills.GET(request)
}
const body = (token: string, id: string, version: string) =>
  skillBody.GET(call("GET", `/skills/${id}/${version}`, { token }))
const ids = async (token: string) =>
  SkillsResponse.parse(await (await list(token)).json()).skills.map((s) => s.id)

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
})
beforeEach(() => harnessEnv(ON))

describe("GET /skills: the cloud's rules, with the device's belt", () => {
  it("required + the agent's assigned skills that need no Kriya tools; never another's", async () => {
    const a = await person()
    const res = await list(a.token)
    expect(res.status).toBe(200)
    const parsed = SkillsResponse.parse(await res.json())
    expect(parsed.skills.map((s) => s.id).sort()).toEqual([
      "debugging-recovery",
      "security-untrusted-content",
      "task-planning",
      "verification-before-completion",
    ])
    // calendar-operations needs calendar_events: not on a laptop; the Studio skill isn't on yet
    const planning = parsed.skills.find((s) => s.id === "task-planning")!
    expect(planning).toMatchObject({
      name: expect.any(String),
      version: "1.0.0",
      description: expect.any(String),
    })
    expect(planning.activation.keywords.length).toBeGreaterThan(0)
  })

  it("owner settings apply: skills.disabled and skills.pins", async () => {
    const a = await person()
    harnessEnv({
      ...ON,
      KRIYA_SKILLS_DISABLED: "task-planning",
      KRIYA_SKILLS_PINS: "debugging-recovery@1.0.0",
    })
    const parsed = SkillsResponse.parse(await (await list(a.token)).json())
    expect(parsed.skills.map((s) => s.id)).not.toContain("task-planning")
    expect(parsed.skills.find((s) => s.id === "debugging-recovery")?.version).toBe(
      "1.0.0"
    )
    expect((await body(a.token, "debugging-recovery", "1.0.0")).status).toBe(200)
    expect((await body(a.token, "debugging-recovery", "1.1.0")).status).toBe(404)
    expect((await body(a.token, "task-planning", "1.0.0")).status).toBe(404)
  })

  it("Studio skills join with next.skillStudio; the person's other skills never", async () => {
    const a = await person()
    const b = await person()
    await studioSkill(a.user)
    expect(await ids(a.token)).not.toContain(STUDIO)
    harnessEnv({ ...ON, KRIYA_NEXT_SKILL_STUDIO: "on" })
    expect(await ids(a.token)).toContain(STUDIO)
    const text = await (await body(a.token, STUDIO, "1.0.0")).text()
    expect(text).toContain("A guest with an allergy")
    expect(await ids(b.token)).not.toContain(STUDIO)
    expect((await body(b.token, STUDIO, "1.0.0")).status).toBe(404)
  })

  it("a body is text/markdown from the same loader as the cloud; unknown or unlisted → 404", async () => {
    const a = await person()
    const res = await body(a.token, "task-planning", "1.0.0")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown/)
    expect((await res.text()).length).toBeGreaterThan(100)
    expect((await body(a.token, "calendar-operations", "1.1.0")).status).toBe(404)
    expect((await body(a.token, "../etc", "1.0.0")).status).toBe(404)
    expect((await body(a.token, "task-planning", "9.9.9")).status).toBe(404)
  })

  it("an ETag: the same list again answers 304", async () => {
    const a = await person()
    const first = await list(a.token)
    const etag = first.headers.get("etag")!
    expect(etag).toMatch(/^"[0-9a-f]{16,}"$/)
    expect((await list(a.token, etag)).status).toBe(304)
    harnessEnv({ ...ON, KRIYA_SKILLS_DISABLED: "task-planning" })
    expect((await list(a.token, etag)).status).toBe(200)
  })

  it("library off, or no agent → an empty list", async () => {
    const a = await person()
    harnessEnv({ ...ON, KRIYA_AGENTS_SKILL_LIBRARY: undefined })
    expect(await ids(a.token)).toEqual([])
    harnessEnv(ON)
    const none = await person(false)
    expect(await ids(none.token)).toEqual([])
  })
})

describe("HT-API-07: memory", () => {
  const save = (token: string, content: string) =>
    memory.POST(call("POST", "/memory", { token, body: { content } }))
  const find = (token: string, query: string, limit?: number) =>
    search.POST(
      call("POST", "/memory/search", { token, body: { query, ...(limit && { limit }) } })
    )

  let n = 0
  async function note(
    user: string,
    agentId: string | null,
    content: string,
    trust = "trusted"
  ) {
    await pg.query(
      "insert into kriya.memories (id, user_id, agent_id, content, source, trust) values ($1, $2, $3, $4, 'user', $5)",
      [`note-${++n}-${user.slice(0, 6)}`, user, agentId, content, trust]
    )
  }

  it("POST /memory saves an unconfirmed note for the device's agent", async () => {
    const a = await person()
    const res = await save(a.token, "The project uses pnpm, not npm.")
    expect(res.status).toBe(201)
    const saved = MemorySaveResponse.parse(await res.json())
    expect(saved.confirmed).toBe(false)
    const { rows } = await pg.query<{
      agent_id: string
      trust: string
      source: string
      user_id: string
    }>("select agent_id, trust, source, user_id from kriya.memories where id = $1", [
      saved.id,
    ])
    expect(rows).toEqual([
      { agent_id: a.agentId, trust: "unconfirmed", source: "agent", user_id: a.user },
    ])
  })

  it("sensitive values are refused, as in the cloud", async () => {
    const a = await person()
    const res = await save(a.token, "My card number is 4111 1111 1111 1111")
    expect(res.status).toBe(400)
    expect(ErrorResponse.parse(await res.json()).message).toMatch(/Not saved/)
    expect((await save(a.token, "x".repeat(1001))).status).toBe(400)
  })

  it("search returns the device agent's notes and shared ones, confirmed first; never another agent's or person's", async () => {
    const a = await person()
    const b = await person()
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('other-agent', $1, 'Disha', 'study', 'g')",
      [a.user]
    )
    await note(a.user, a.agentId, "pnpm builds the project", "unconfirmed")
    await note(a.user, a.agentId, "pnpm is the package manager here")
    await note(a.user, null, "pnpm caches live in the home folder")
    await note(a.user, "other-agent", "pnpm notes for Disha only")
    await note(b.user, b.agentId, "pnpm notes of another person")
    const res = await find(a.token, "pnpm")
    expect(res.status).toBe(200)
    const { notes } = MemorySearchResponse.parse(await res.json())
    expect(notes.map((n) => n.content)).toEqual([
      expect.stringMatching(/pnpm (is the package manager|caches)/),
      expect.stringMatching(/pnpm (is the package manager|caches)/),
      "pnpm builds the project",
    ])
    expect(notes.at(-1)).toMatchObject({ confirmed: false, shared: false })
    expect(notes.find((n) => n.content.includes("caches"))).toMatchObject({
      shared: true,
      confirmed: true,
    })
    expect(JSON.stringify(notes)).not.toMatch(/Disha|another person/)
    expect(
      MemorySearchResponse.parse(await (await find(a.token, "pnpm", 1)).json()).notes
    ).toHaveLength(1)
  })

  it("memory v2 off → 404; no agent → 409; the request is the contract", async () => {
    const a = await person()
    harnessEnv({ ...ON, KRIYA_AGENTS_MEMORY_V2: undefined })
    expect((await find(a.token, "x")).status).toBe(404)
    expect((await save(a.token, "x")).status).toBe(404)
    harnessEnv(ON)
    const none = await person(false)
    const refused = await save(none.token, "a note")
    expect(refused.status).toBe(409)
    expect(ErrorResponse.parse(await refused.json())).toMatchObject({ error: "no_agent" })
    expect((await find(a.token, "q".repeat(501))).status).toBe(400)
    expect((await find(a.token, "pnpm", 21)).status).toBe(400)
    expect(
      (
        await memory.POST(
          call("POST", "/memory", {
            token: a.token,
            body: { content: "x", trust: "trusted" },
          })
        )
      ).status
    ).toBe(400)
  })
})
