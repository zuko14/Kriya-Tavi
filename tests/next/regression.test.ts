import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// NT-REG-01 (NR-2): with every next.* switch off, track N changes nothing a
// person or the model can see. The tracks' own snapshot suites (AT-REG-01,
// OT-REG-01, tests/agent/regression.test.ts and the operator golden jobs) run
// in the same `npm test` with the switches unset; this file adds what only
// track N can show: every next.* switch ships off, off is the same as unset,
// `runTask` hands the model today's approvals object itself, the belt and
// prompt are byte for byte the same, the registry is never read, and a run's
// record is the one it always was.

const seen = vi.hoisted(() => ({
  approvals: [] as unknown[],
  tools: [] as string[][],
  prompts: [] as string[],
  sql: [] as string[],
}))

vi.mock("ai", async (original) => {
  const actual = await original<typeof import("ai")>()
  return {
    ...actual,
    streamText: ((options: Parameters<typeof actual.streamText>[0]) => {
      seen.approvals.push(options.toolApproval)
      return actual.streamText(options)
    }) as typeof actual.streamText,
  }
})
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "", email: null }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock(
  "@/lib/connectors",
  async (original) =>
    (await import("./golden/mocks")).connectors(await original()) as never
)
vi.mock("@/lib/models", async (original) => {
  const mocks = await import("./golden/mocks")
  const real = mocks.modelMock(await original())
  return {
    ...real,
    createGatewayModel: (modelId: string) => {
      const model = (real.createGatewayModel as (id: string) => { doStream: unknown })(
        modelId
      )
      const doStream = model.doStream as (o: { tools?: { name: string }[] }) => unknown
      ;(model as { doStream: unknown }).doStream = async (
        options: Parameters<typeof doStream>[0]
      ) => {
        seen.tools.push((options.tools ?? []).map((t) => t.name))
        return doStream(options)
      }
      return model
    },
  }
})

import { SETTINGS } from "@/lib/config"
import { TOOL_APPROVALS } from "@/lib/agent/run-task"

import { call, model, say, switches, world, type World } from "../operator/golden/harness"
import { answerAll } from "./golden/harness"
import { reset, seen as mocks } from "./golden/mocks"

const NEXT_KEYS = Object.keys(SETTINGS).filter((key) => key.startsWith("next."))
const envOf = (key: string) =>
  (SETTINGS as unknown as Record<string, { env: string }>)[key].env

let w: World
beforeEach(async () => {
  reset()
  seen.approvals.length = seen.tools.length = seen.prompts.length = seen.sql.length = 0
  w = await world()
  // Everything the registry would be read for, if it were read
  await w.q(
    "insert into kriya.mcp_servers (id, name, url, auth, status) values ('tracker', 'Tracker', 'https://tracker.example.test/mcp', 'none', 'active')"
  )
  const original = w.pg.query.bind(w.pg) as (...args: unknown[]) => Promise<unknown>
  ;(w.pg as unknown as { query: unknown }).query = (...args: unknown[]) => {
    if (typeof args[0] === "string") seen.sql.push(args[0])
    return original(...args)
  }
})
afterEach(() => {
  for (const key of NEXT_KEYS) delete process.env[envOf(key)]
  switches(false)
  model.script = () => say("Done.")
})

const setAll = (value: "off" | null) => {
  for (const key of NEXT_KEYS) {
    const env = envOf(key)
    // Switches only: the model id, the tool budget and the like stay unset
    if (
      (SETTINGS as unknown as Record<string, { pattern?: RegExp }>)[key].pattern
        ?.source === "^(on|off)$"
    ) {
      if (value) process.env[env] = value
      else delete process.env[env]
    }
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

describe("NT-REG-01: every next.* switch off", () => {
  it("each on/off switch of the track ships off", () => {
    const switchesOf = NEXT_KEYS.filter(
      (key) =>
        (SETTINGS as unknown as Record<string, { pattern?: RegExp }>)[key].pattern
          ?.source === "^(on|off)$"
    )
    // delivery, recheck, reliability, skillsV2, mcp, mcpConnect, memoryRerank, promptCache
    expect(switchesOf.sort()).toEqual([
      "next.delivery",
      "next.mcp",
      "next.mcpConnect",
      "next.memoryRerank",
      "next.promptCache",
      "next.recheck",
      "next.reliability",
      "next.skillsV2",
    ])
    for (const key of switchesOf)
      expect(
        (SETTINGS as unknown as Record<string, { fallback?: string }>)[key].fallback
      ).toBe("off")
  })

  it("off equals unset: the same approvals object, belt and prompt; the registry is never read", async () => {
    model.script = () => say("Hello.")
    setAll(null)
    await w.turn("hello")
    setAll("off")
    await w.turn("hello")
    expect(seen.approvals).toHaveLength(2)
    for (const approvals of seen.approvals) expect(approvals).toBe(TOOL_APPROVALS)
    expect(seen.tools).toHaveLength(2)
    expect(seen.tools[1]).toEqual(seen.tools[0])
    expect(seen.tools[0].filter((name) => name.startsWith("mcp_"))).toEqual([])
    expect(mocks.prompts).toHaveLength(2)
    expect(mocks.prompts[1]).toBe(mocks.prompts[0])
    expect(mocks.prompts[0]).not.toContain("**Apps.**")
    // Nothing of track N was read or written
    const tables = /mcp_(servers|tools|enablements|connections)|delivery_checks/
    expect(seen.sql.filter((sql) => tables.test(sql))).toEqual([])
  })

  it("a run's record is the one it always was: no delivery rows, no class on the run", async () => {
    setAll("off")
    model.script = (run, results) =>
      run.includes("DRAFT") && results === 0
        ? call(
            "gmail_draft",
            { to: ["a@example.com"], subject: "Hi", body: "Hello" },
            "c1"
          )
        : say("Saved the draft.")
    await w.turn("DRAFT: a note")
    await answerAll(w)
    expect(
      await w.q("select tool_name, side_effect, risk from kriya.tool_executions")
    ).toEqual([{ tool_name: "gmail_draft", side_effect: true, risk: null }])
    expect(await w.q("select 1 from kriya.delivery_checks")).toEqual([])
    const [episode] = await w.q<{ done: { tool: string }[]; unconfirmed: unknown[] }>(
      "select done, unconfirmed from kriya.episodes"
    )
    expect(episode.done.map((d) => d.tool)).toEqual(["gmail_draft"])
    expect(episode.unconfirmed).toEqual([])
  })
})
