import { tool, type ModelMessage, type ToolSet } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createBrowserTools, createSkillTools, type ToolEnv } from "@/lib/agent/tools"
import { TaskBrowser } from "@/lib/browser/session"
import { checkSkillAllowed } from "@/lib/entitlements"
import {
  approvedSkill,
  buildSteps,
  fillSlots,
  lastTurnCalls,
  proposeSkill,
  runSkill,
  type ReplayEnv,
} from "@/lib/skills"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"
import { el, FixtureBrowser } from "./fixture-browser"

// Skills (A9, AD-21). AT-SKL-01: an approved skill replays on an unchanged
// fixture page with no model involved, finding the clicked link again by
// role and name although its ref changed. AT-SKL-02: a changed page makes
// the replay hand the rest to the agent once; the second miss puts the
// skill in the Inbox. AT-SKL-03: every replayed step is classified again,
// can't exceed the skill's max_risk, and anything needing approval is
// handed back instead of run.

const SHOP = "https://shop.example.test/"
const PRICING = "https://shop.example.test/pricing"

let pg: TestDb
let user: string
let taskId: string
let fake: FixtureBrowser
let browser: TaskBrowser
let belt: ToolSet
const comment = vi.fn(async () => ({ done: true }))

const env = (): ToolEnv => ({
  current: () => ({ id: "a1" }) as schema.Agent,
  userId: user,
  threadId: "t1",
  taskId,
})

const replayEnv = (over: Partial<ReplayEnv> = {}): ReplayEnv => ({
  userId: user,
  tools: belt,
  page: () => browser.view,
  messages: [],
  privateSeen: false,
  isPrivateRead: (name) => name === "gmail_read",
  ...over,
})

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const call = (name: string, input: Record<string, unknown>) =>
  (belt[name].execute as Exec)(input, {
    toolCallId: "c",
    messages: [],
    context: undefined,
  })

// One finished turn as the model saw it: the person asked, the agent opened
// the shop and followed Pricing
async function recordedTurn(): Promise<ModelMessage[]> {
  const opened = await call("browser_open", { url: SHOP })
  const clicked = await call("browser_click", { ref: "e2" })
  const messages: ModelMessage[] = [{ role: "user", content: "Check the shop's pricing" }]
  const steps: [string, string, Record<string, unknown>, unknown][] = [
    ["c1", "browser_open", { url: SHOP }, opened],
    ["c2", "browser_click", { ref: "e2" }, clicked],
  ]
  for (const [id, toolName, input, output] of steps) {
    messages.push(
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName, input }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName,
            output: { type: "json", value: output as never },
          },
        ],
      }
    )
  }
  return messages
}

// The person's approval, as actions/skills.ts does it
const approve = (id: string) =>
  asUser(pg, user, (tx) =>
    tx.query(
      "update kriya.skills set status = 'approved', approved_at = now() where id = $1",
      [id]
    )
  )

async function savedShopSkill() {
  const row = await proposeSkill({
    userId: user,
    agentId: "a1",
    taskId,
    name: "Check pricing",
    slots: [],
    messages: await recordedTurn(),
  })
  await approve(row.id)
  return (await approvedSkill(user, row.id))!
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await pg.query("update kriya.plans set browser_minutes = 10, max_skills = 3")
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Meera', 'r', 'g')",
    [user]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
    [user]
  )
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [user]
  )
  taskId = rows[0].id
  fake = new FixtureBrowser()
  fake.pages = {
    [SHOP]: {
      title: "Shop",
      elements: [
        el("e1", { name: "Home" }),
        el("e2", { name: "Pricing", href: PRICING }),
      ],
    },
    [PRICING]: { title: "Pricing", elements: [] },
  }
  browser = new TaskBrowser(fake, { id: taskId, userId: user })
  comment.mockClear()
  belt = {
    ...createBrowserTools(browser),
    github_comment: tool({
      description: "test double",
      inputSchema: z.object({ repo: z.string(), number: z.number(), body: z.string() }),
      execute: comment,
    }),
  }
})

describe("saving", () => {
  it("turns the turn's calls into steps, with a locator instead of the ref", async () => {
    const steps = buildSteps(lastTurnCalls(await recordedTurn()), [])
    expect(steps).toEqual([
      { tool: "browser_open", input: { url: SHOP } },
      { tool: "browser_click", input: {}, locator: { role: "link", name: "Pricing" } },
    ])
  })

  it("is born a draft that only the person's approval makes runnable", async () => {
    const row = await proposeSkill({
      userId: user,
      agentId: "a1",
      taskId,
      name: "Check pricing",
      slots: [],
      messages: await recordedTurn(),
    })
    expect(row).toMatchObject({ status: "draft", version: 1, maxRisk: "R0" })
    expect(await approvedSkill(user, row.id)).toBeNull()
  })

  it("turns slot values into placeholders, and refuses a value that isn't there", async () => {
    const calls = lastTurnCalls(await recordedTurn())
    const [open] = buildSteps(calls, [
      { name: "site", description: "Shop", required: true, value: "shop.example.test" },
    ])
    expect(open.input).toEqual({ url: "https://{{site}}/" })
    expect(() =>
      buildSteps(calls, [
        { name: "x", description: "x", required: true, value: "nowhere" },
      ])
    ).toThrow(/isn't in any step/)
    expect(
      fillSlots({ steps: [open], slots: [] }, { site: "other.test" })[0].input
    ).toEqual({ url: "https://other.test/" })
    expect(() =>
      fillSlots(
        { steps: [open], slots: [{ name: "site", description: "Shop", required: true }] },
        {}
      )
    ).toThrow(/site is needed/)
  })

  it("stays within the plan's skill limit", async () => {
    await pg.query("update kriya.plans set max_skills = 0")
    expect(await checkSkillAllowed(user, "Check pricing")).toMatchObject({
      ok: false,
      code: "skill_limit",
    })
  })

  it("skill_propose saves a draft and describes its steps", async () => {
    const tools = createSkillTools(env(), () => belt, browser)
    const messages = await recordedTurn()
    const result = (await (tools.skill_propose.execute as Exec)(
      { name: "Check pricing", slots: [] },
      { toolCallId: "p", messages, context: undefined }
    )) as { status: string; steps: string[] }
    expect(result.status).toBe("draft")
    expect(result.steps).toEqual([
      `browser open: {"url":"${SHOP}"}`,
      'browser click: link "Pricing"',
    ])
  })
})

describe("AT-SKL-01: deterministic replay on an unchanged page", () => {
  it("runs every step with no model, finding the link though its ref changed", async () => {
    const skill = await savedShopSkill()
    fake.calls = []
    fake.pages[SHOP].elements = [
      el("e5", { name: "Pricing", href: PRICING }),
      el("e6", { name: "Home" }),
    ]
    const outcome = await runSkill(replayEnv(), skill, {})
    expect(outcome.status).toBe("done")
    expect(fake.calls).toEqual([`open ${SHOP}`, "click"])
    expect(fake.url).toBe(PRICING)
    const [row] = (
      await pg.query<{ runs: number; successes: number; failures: number }>(
        "select runs, successes, failures from kriya.skills"
      )
    ).rows
    expect(row).toEqual({ runs: 1, successes: 1, failures: 0 })
  })
})

describe("AT-SKL-02: a changed page falls back to the agent once, then the Inbox", () => {
  it("hands the rest to the agent, then waits for the person", async () => {
    const skill = await savedShopSkill()
    fake.pages[SHOP].elements = [el("e2", { name: "Plans", href: PRICING })]
    const first = await runSkill(replayEnv(), skill, {})
    expect(first).toMatchObject({ status: "diverged", step: 2 })
    expect(first.status === "diverged" && first.remaining).toEqual([
      { tool: "browser_click", input: {}, locator: { role: "link", name: "Pricing" } },
    ])
    const again = await runSkill(replayEnv(), (await approvedSkill(user, skill.id))!, {})
    expect(again.status).toBe("needs_review")
    const [row] = (
      await pg.query<{ failures: number }>("select failures from kriya.skills")
    ).rows
    expect(row.failures).toBe(2)
  })
})

describe("AT-SKL-03: re-classified, capped, approvals handed back", () => {
  it("refuses a step that has become a commit on the page", async () => {
    const skill = await savedShopSkill()
    fake.calls = []
    // Same role and name, but now it submits a form
    fake.pages[SHOP].elements = [el("e2", { name: "Pricing", type: "submit" })]
    const outcome = await runSkill(replayEnv(), skill, {})
    expect(outcome).toMatchObject({
      status: "diverged",
      step: 2,
      reason: expect.stringMatching(/R4 now, above the skill's R0/),
    })
    expect(fake.calls).toEqual([`open ${SHOP}`])
  })

  it("hands back a step that needs approval without running it", async () => {
    const skill = {
      ...(await savedShopSkill()),
      maxRisk: "R4" as const,
      steps: [
        { tool: "browser_open", input: { url: SHOP } },
        {
          tool: "github_comment",
          input: { repo: "octo-org/kriya-demo", number: 7, body: "Thanks {{who}}" },
        },
      ],
      slots: [{ name: "who", description: "Who to thank", required: true }],
    }
    const outcome = await runSkill(replayEnv(), skill, { who: "Asha" })
    expect(outcome).toMatchObject({
      status: "continue",
      next: [
        {
          tool: "github_comment",
          input: { repo: "octo-org/kriya-demo", number: 7, body: "Thanks Asha" },
        },
      ],
    })
    expect(comment).not.toHaveBeenCalled()
  })

  it("hands back a web request once private content is in the turn", async () => {
    const skill = await savedShopSkill()
    fake.calls = []
    const outcome = await runSkill(replayEnv({ privateSeen: true }), skill, {})
    expect(outcome.status).toBe("continue")
    expect(fake.calls).toEqual([])
  })
})

describe("database guarantees", () => {
  it("nothing is inserted approved, and another person sees nothing", async () => {
    await expect(
      asUser(pg, user, (tx) =>
        tx.query(
          `insert into kriya.skills (id, version, user_id, name, status, approved_at, max_risk, steps)
           values ('s1', 1, $1, 'Sneaky', 'approved', now(), 'R0', '[{"tool":"web_search","input":{}}]')`,
          [user]
        )
      )
    ).rejects.toThrow(/row-level security/)
    await savedShopSkill()
    const other = await createUser(pg)
    const { rows } = await asUser(pg, other, (tx) =>
      tx.query("select 1 from kriya.skills")
    )
    expect(rows).toEqual([])
  })

  it("an approved skill can be retired but never goes back to draft", async () => {
    const skill = await savedShopSkill()
    await expect(
      asUser(pg, user, (tx) =>
        tx.query("update kriya.skills set status = 'draft' where id = $1", [skill.id])
      )
    ).rejects.toThrow(/can't go from approved to draft/)
    await asUser(pg, user, (tx) =>
      tx.query("update kriya.skills set status = 'retired' where id = $1", [skill.id])
    )
  })
})
