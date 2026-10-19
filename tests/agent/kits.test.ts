import type { ModelMessage } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createKitTools, type ToolEnv } from "@/lib/agent/tools"
import { checkKit, fitKit } from "@/lib/browser/kits"
import type { PageElement, PageView } from "@/lib/browser/provider"
import { TaskBrowser } from "@/lib/browser/session"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import { el, FixtureBrowser } from "./fixture-browser"

// K9 ready-to-apply kits (AD-35): limits read from the page by code
// (AT-KIT-01), and "verified" only when the public page shows the text
// (AT-KIT-02). Kits are text for the person; nothing is pressed.

const field = (ref: string, name: string, maxLength?: number): PageElement => ({
  ref,
  role: "textbox",
  name,
  inForm: true,
  sensitive: false,
  ...(maxLength && { maxLength }),
})

const FORM: PageView = {
  elements: [field("e1", "Headline", 60), field("e2", "About", 200), field("e3", "City")],
  facts: {
    url: "http://profile-editor.fixture.test/intro",
    domain: "fixture.test",
    hasForm: true,
    focusedSensitive: false,
    captcha: false,
  },
}

type Execute = (
  input: Record<string, unknown>,
  options: { toolCallId: string; messages: ModelMessage[] }
) => Promise<Record<string, unknown>>
const call = (tool: { execute?: unknown }, input: Record<string, unknown>) =>
  (tool.execute as Execute)(input, { toolCallId: "c1", messages: [] })

describe("AT-KIT-01 fields fit the limits the page declares", () => {
  it("reads each field's limit by its label", () => {
    const fitted = fitKit(
      [
        { label: "Headline", text: "Data analyst, Pune" },
        { label: " about ", text: "Hello" },
        { label: "City", text: "Pune" },
      ],
      FORM
    )
    expect(fitted).toEqual({
      ok: true,
      limitsRead: true,
      fields: [
        { label: "Headline", text: "Data analyst, Pune", limit: 60 },
        { label: " about ", text: "Hello", limit: 200 },
        { label: "City", text: "Pune", limit: null },
      ],
    })
  })

  it("refuses text over a limit, counted as the browser counts it", () => {
    const over = fitKit([{ label: "Headline", text: "x".repeat(61) }], FORM)
    expect(over).toEqual({
      ok: false,
      problems: ['"Headline" is 61 characters; the site allows 60. Shorten it.'],
    })
    // An emoji is two UTF-16 units, as maxlength counts
    expect(fitKit([{ label: "Headline", text: "😀".repeat(31) }], FORM).ok).toBe(false)
    expect(fitKit([{ label: "Headline", text: "x".repeat(60) }], FORM).ok).toBe(true)
  })

  it("without a page, says the limits weren't read", () => {
    expect(fitKit([{ label: "Headline", text: "x".repeat(500) }], null)).toMatchObject({
      ok: true,
      limitsRead: false,
    })
  })
})

describe("AT-KIT-02 verified only when the page shows the text", () => {
  const fields = [
    { label: "Headline", text: "Data analyst, Pune", limit: 60 },
    { label: "About", text: "I build  dashboards.", limit: 200 },
  ]
  it("verified when every field's text is on the page (spacing and case aside)", () => {
    expect(
      checkKit(fields, "Public profile\nDATA ANALYST, PUNE\nI build dashboards.")
    ).toBe("verified")
  })
  it("unverified when any is missing", () => {
    expect(checkKit(fields, "Public profile\nData analyst, Pune")).toBe("unverified")
    expect(checkKit(fields, "No headline yet")).toBe("unverified")
  })
})

describe("kit tools", () => {
  let pg: TestDb
  let user: string
  let taskId: string
  let fake: FixtureBrowser
  let tools: ReturnType<typeof createKitTools>

  const kit = {
    title: "Intro",
    deepLink: "http://profile-editor.fixture.test/intro",
    verifyUrl: "http://profile-editor.fixture.test/public",
    fields: [{ label: "Headline", text: "Data analyst, Pune" }],
    checklist: ["Press Save"],
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
    fake = new FixtureBrowser()
    fake.pages = {
      "http://profile-editor.fixture.test/intro": {
        title: "Edit intro",
        elements: FORM.elements,
      },
      "http://profile-editor.fixture.test/public": {
        title: "Public profile",
        elements: [el("e1", { role: "heading", name: "Public profile" })],
      },
    }
    const env = { userId: user, threadId: "t1", taskId } as ToolEnv
    tools = createKitTools(env, new TaskBrowser(fake, { id: taskId, userId: user }))
  })

  it("kit_prepare reads the form, and refuses text over its limit", async () => {
    const tooLong = await call(tools.kit_prepare, {
      ...kit,
      fields: [{ label: "Headline", text: "x".repeat(70) }],
    })
    expect(tooLong).toMatchObject({ done: false })
    const made = await call(tools.kit_prepare, kit)
    expect(made).toMatchObject({ done: true, limitsRead: true, limits: [60] })
    expect(fake.calls).toContain("open http://profile-editor.fixture.test/intro")
    // Only pages opened: never a click, a fill or a submit
    expect(fake.calls.every((c) => c.startsWith("open "))).toBe(true)
    const { rows } = await pg.query(
      "select domain, status, fields from kriya.kits where id = $1",
      [made.kitId]
    )
    expect(rows).toEqual([
      {
        domain: "fixture.test",
        status: "ready",
        fields: [{ label: "Headline", text: "Data analyst, Pune", limit: 60 }],
      },
    ])
  })

  it("kit_check marks verified only when the public page shows the text", async () => {
    const made = await call(tools.kit_prepare, kit)
    // Not applied yet: the page doesn't show it
    const before = await call(tools.kit_check, { kitId: made.kitId })
    expect(before).toMatchObject({ done: true, status: "unverified" })
    expect(before.verification).toMatchObject({
      status: "unverified",
      method: "page_check",
    })
    // Applied: the public page shows it now (the fake's text is "Text of <title>")
    fake.pages["http://profile-editor.fixture.test/public"].title =
      "Public profile Data analyst, Pune"
    const after = await call(tools.kit_check, { kitId: made.kitId })
    expect(after).toMatchObject({ done: true, status: "verified" })
    const { rows } = await pg.query<{ status: string; checked_at: Date | null }>(
      "select status, checked_at from kriya.kits where id = $1",
      [made.kitId]
    )
    expect(rows[0].status).toBe("verified")
    expect(rows[0].checked_at).not.toBeNull()
  })

  it("kit_check can't see or verify another person's kit", async () => {
    const made = await call(tools.kit_prepare, kit)
    const stranger = await createUser(pg)
    const theirs = createKitTools(
      { userId: stranger, threadId: "t9" } as ToolEnv,
      new TaskBrowser(fake, { id: taskId, userId: stranger })
    )
    expect(await call(theirs.kit_check, { kitId: made.kitId })).toEqual({
      done: false,
      message: "No such kit.",
    })
  })

  it("without a browser, kits still work and say the limits weren't read", async () => {
    const bare = createKitTools({ userId: user, threadId: "t1", taskId } as ToolEnv, null)
    expect(await call(bare.kit_prepare, kit)).toMatchObject({
      done: true,
      limitsRead: false,
    })
  })
})
