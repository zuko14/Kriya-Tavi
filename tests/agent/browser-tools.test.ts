import type { ModelMessage } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createBrowserTools, untrustedSeen } from "@/lib/agent/tools"
import type {
  ActionResult,
  BrowserAction,
  BrowserProvider,
  PageElement,
  Snapshot,
} from "@/lib/browser/provider"
import { TaskBrowser } from "@/lib/browser/session"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// The runner's browser tools (A4, owner's AF-27 decision): reads and
// hand-offs only. The policy decides every step before the browser is
// touched; fills and commits are refused. Sessions open within the plan's
// browser minutes and are metered when the task ends.

let pg: TestDb
let user: string
let taskId: string

// A scripted kriya-browser: pages by URL, every call recorded
class FakeBrowser implements BrowserProvider {
  calls: string[] = []
  pages: Record<string, { title: string; elements: PageElement[]; captcha?: boolean }> =
    {}
  url = "about:blank"
  closed = 0
  snapshotOf(): Snapshot {
    const page = this.pages[this.url] ?? { title: "Blank", elements: [] }
    return {
      title: page.title,
      elements: page.elements,
      text: `Text of ${page.title}`,
      diff: null,
      facts: {
        url: this.url,
        domain: new URL(this.url).hostname.split(".").slice(-2).join("."),
        hasForm: page.elements.some((e) => e.inForm),
        focusedSensitive: false,
        captcha: page.captcha ?? false,
      },
    }
  }
  sessions = 0
  async open() {
    this.calls.push("open-session")
    return { sessionId: `6f1c3c1e-0000-4000-8000-00000000000${++this.sessions}` }
  }
  async act(_id: string, action: BrowserAction): Promise<ActionResult> {
    this.calls.push(action.action === "open" ? `open ${action.url}` : action.action)
    if (action.action === "open") this.url = action.url
    if (action.action === "click") {
      const link = this.snapshotOf().elements.find((e) => e.ref === action.ref)
      if (link?.href) this.url = link.href
    }
    return { ok: true, snapshot: this.snapshotOf() }
  }
  async snapshot() {
    return this.snapshotOf()
  }
  async heartbeat() {
    return true
  }
  async close() {
    this.closed++
    return { seconds: 42 }
  }
  async renderPdf() {
    return Buffer.from("%PDF-")
  }
}

const el = (ref: string, over: Partial<PageElement>): PageElement => ({
  ref,
  role: "button",
  name: "",
  inForm: false,
  sensitive: false,
  ...over,
})

let fake: FakeBrowser
let browser: TaskBrowser
let tools: ReturnType<typeof createBrowserTools>

const run = async (name: keyof typeof tools, input: Record<string, unknown>) => {
  const execute = tools[name].execute as unknown as (
    input: Record<string, unknown>,
    options: { toolCallId: string; messages: ModelMessage[] }
  ) => Promise<Record<string, unknown>>
  return execute(input, { toolCallId: "c1", messages: [] })
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  await pg.query("update kriya.plans set browser_minutes = 10 where id = 'free'")
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
  fake = new FakeBrowser()
  fake.pages = {
    "https://example.com/": {
      title: "Example",
      elements: [
        el("e1", { role: "link", name: "Pricing", href: "https://example.com/pricing" }),
        el("e2", { name: "Save", inForm: true, type: "submit" }),
        el("e3", { name: "Like" }),
      ],
    },
    "https://example.com/pricing": { title: "Pricing", elements: [] },
    "https://www.linkedin.com/in/someone": {
      title: "Profile",
      elements: [el("e1", { name: "Connect" })],
    },
    "https://captcha.example/": {
      title: "Check",
      elements: [el("e1", { role: "link", name: "Next" })],
      captcha: true,
    },
  }
  browser = new TaskBrowser(fake, { id: taskId, userId: user })
  tools = createBrowserTools(browser)
})

describe("browser tools (read-only runner)", () => {
  it("offers reads and hand-offs only: no typing, choosing or screenshots", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "browser_click",
      "browser_close",
      "browser_handoff",
      "browser_open",
      "browser_scroll",
      "browser_snapshot",
    ])
  })

  it("opens a page lazily and returns it as untrusted text with refs", async () => {
    expect(fake.calls).toEqual([])
    const result = await run("browser_open", { url: "https://example.com/" })
    expect(fake.calls).toEqual(["open-session", "open https://example.com/"])
    expect(result.done).toBe(true)
    expect(result.notice).toMatch(/Untrusted/)
    expect(result.page).toContain('e1 link "Pricing"')
  })

  it("follows links, but refuses commits and social actions without touching the page", async () => {
    await run("browser_open", { url: "https://example.com/" })
    expect((await run("browser_click", { ref: "e1" })).done).toBe(true)
    await run("browser_open", { url: "https://example.com/" })
    const before = fake.calls.length
    for (const ref of ["e2", "e3"]) {
      const result = await run("browser_click", { ref })
      expect(result).toMatchObject({ done: false, class: "R4" })
    }
    expect(fake.calls.length).toBe(before)
  })

  it("a stated commit intent raises a link click to a refusal", async () => {
    await run("browser_open", { url: "https://example.com/" })
    expect(await run("browser_click", { ref: "e1", intent: "commit" })).toMatchObject({
      done: false,
      class: "R4",
    })
  })

  it("assisted sites: reading is fine, Connect is refused with a review hand-off", async () => {
    const opened = await run("browser_open", {
      url: "https://www.linkedin.com/in/someone",
    })
    expect(opened.done).toBe(true)
    const result = await run("browser_click", { ref: "e1" })
    expect(result).toMatchObject({ done: false, class: "R4" })
    expect(String(result.reason)).toMatch(/assisted/)
  })

  it("on a CAPTCHA page every step but hand-off is R5", async () => {
    await run("browser_open", { url: "https://captcha.example/" })
    const result = await run("browser_click", { ref: "e1" })
    expect(result).toMatchObject({ done: false, class: "R5" })
    expect(String(result.reason)).toMatch(/browser_handoff/)
    const handoff = await run("browser_handoff", { reason: "captcha", note: "Solve it" })
    expect(handoff).toMatchObject({ done: true })
  })

  it("after browser_close, the next step opens a new session", async () => {
    await run("browser_open", { url: "https://example.com/" })
    await run("browser_close", {})
    const again = await run("browser_open", { url: "https://example.com/pricing" })
    expect(again.done).toBe(true)
    expect(fake.sessions).toBe(2)
    const { rows } = await pg.query<{ status: string }>(
      "select status from kriya.browser_sessions order by opened_at"
    )
    expect(rows.map((r) => r.status).sort()).toEqual(["closed", "open"])
  })

  it("closes once and meters the seconds as browser usage", async () => {
    await run("browser_open", { url: "https://example.com/" })
    await browser.close()
    await browser.close()
    expect(fake.closed).toBe(1)
    const { rows: sessions } = await pg.query(
      "select status, seconds, user_id from kriya.browser_sessions"
    )
    expect(sessions).toEqual([{ status: "closed", seconds: 42, user_id: user }])
    const { rows: usage } = await pg.query(
      "select kind, quantity::int, cost_micro_usd from kriya.resource_usage"
    )
    expect(usage).toEqual([
      { kind: "browser_seconds", quantity: 42, cost_micro_usd: null },
    ])
  })

  it("refuses to open beyond the plan's browser minutes, and closes the session it got", async () => {
    await pg.query("update kriya.plans set browser_minutes = 0 where id = 'free'")
    const result = await run("browser_open", { url: "https://example.com/" })
    expect(result).toMatchObject({ done: false })
    expect(String(result.message)).toMatch(/minutes/)
    expect(fake.closed).toBe(1)
  })

  it("a page read through the browser quarantines later memory writes", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c", toolName: "browser_open", input: {} },
        ],
      },
    ] as ModelMessage[]
    expect(untrustedSeen(messages)).toBe(true)
  })
})
