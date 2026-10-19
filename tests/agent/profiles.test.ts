import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { ModelMessage } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { browserDecision, classifyBrowserAction } from "@/lib/agent/policy"
import { createBrowserTools } from "@/lib/agent/tools"
import {
  finishSignIn,
  openState,
  profileForTask,
  profileJanitor,
  scopeState,
  sealState,
  startSignIn,
} from "@/lib/browser/profiles"
import type {
  ActionResult,
  BrowserAction,
  BrowserProvider,
  OpenSession,
  PageElement,
  Snapshot,
  StorageState,
} from "@/lib/browser/provider"
import { TaskBrowser } from "@/lib/browser/session"
import { log, __test } from "@/lib/log"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Login profiles (A6, AD-05): sealed state that opens only for its own row
// and person (AT-SEC-02), background use only with both switches
// (AT-SCH-06), expiry by time and by the site signing the person out,
// take-over sign-in and save, signed-in sessions kept on their site
// (AT-BRW-08), and logs that never carry session state (AT-SEC-03).

const PASSWORD = "fixture-secret-hunter2"
const COOKIE = "li_at_fixture_value_9f8e7d"

const STATE: StorageState = {
  cookies: [
    {
      name: "session",
      value: COOKIE,
      domain: ".fixture.test",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
    {
      name: "tracker",
      value: "elsewhere",
      domain: "ads.example",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ],
  origins: [
    {
      origin: "http://profile-editor.fixture.test",
      localStorage: [{ name: "headline", value: "Hi" }],
    },
    { origin: "https://ads.example", localStorage: [{ name: "id", value: "x" }] },
  ],
}

const el = (ref: string, over: Partial<PageElement>): PageElement => ({
  ref,
  role: "link",
  name: "",
  inForm: false,
  sensitive: false,
  ...over,
})

// A scripted kriya-browser: pages by URL; records what each session got
class ProfileBrowser implements BrowserProvider {
  opened: OpenSession[] = []
  closes: { captureState?: boolean }[] = []
  url = "about:blank"
  signedOut = false
  state: StorageState | undefined = STATE
  snap(): Snapshot {
    const host = new URL(this.url).hostname
    const login = this.signedOut && this.url.includes("/account")
    return {
      title: login ? "Sign in" : "Page",
      elements: login
        ? [
            el("e1", {
              role: "textbox",
              name: "Password",
              sensitive: true,
              type: "password",
            }),
          ]
        : [el("e1", { name: "Elsewhere", href: "https://exfil.test/collect" })],
      text: login ? "Sign in" : "Signed in as Fixture Person.",
      diff: null,
      facts: {
        url: this.url,
        domain: host.split(".").slice(-2).join("."),
        hasForm: login,
        focusedSensitive: false,
        captcha: false,
      },
    }
  }
  private n = 0
  async open(input: OpenSession) {
    this.opened.push(input)
    return { sessionId: `6f1c3c1e-0000-4000-8000-00000000000${++this.n}` }
  }
  async act(_id: string, action: BrowserAction): Promise<ActionResult> {
    if (action.action === "open") this.url = action.url
    return { ok: true, snapshot: this.snap() }
  }
  async snapshot() {
    return this.snap()
  }
  async heartbeat() {
    return true
  }
  async close(_id: string, captureState?: boolean) {
    this.closes.push({ captureState })
    return { seconds: 30, ...(captureState && this.state && { state: this.state }) }
  }
  async renderPdf() {
    return Buffer.from("%PDF-")
  }
}

let pg: TestDb
let user: string
let other: string
let taskId: string

const sealed = async (id: string) =>
  (
    await pg.query<{ state_sealed: string | null; status: string }>(
      "select state_sealed, status from kriya.login_profiles where id = $1",
      [id]
    )
  ).rows[0]

// The server's side: a saved profile, as finishSignIn leaves it
async function savedProfile(owner = user, domain = "fixture.test", extra = "") {
  const { rows } = await pg.query<{ id: string }>(
    "insert into kriya.login_profiles (user_id, domain, label) values ($1, $2, $3) returning id",
    [owner, domain, `L${randomBytes(3).toString("hex")}`]
  )
  const id = rows[0].id
  await pg.query(
    `update kriya.login_profiles set status = 'active', state_sealed = $2, confirmed_at = now(),
       expires_at = now() + interval '90 days' where id = $1`,
    [id, sealState(owner, id, scopeState(STATE, domain))]
  )
  if (extra) {
    await pg.query(`update kriya.login_profiles set ${extra} where id = $1`, [id])
  }
  return id
}

type Execute = (
  input: Record<string, unknown>,
  options: { toolCallId: string; messages: ModelMessage[] }
) => Promise<Record<string, unknown>>
const call = (tool: { execute?: unknown }, input: Record<string, unknown>) =>
  (tool.execute as Execute)(input, { toolCallId: "c1", messages: [] })

beforeAll(() => {
  process.env.KRIYA_TOKEN_KEY = randomBytes(32).toString("base64")
})

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  await pg.query(
    "update kriya.plans set browser_minutes = 10, max_login_profiles = 3 where id = 'free'"
  )
  user = await createUser(pg)
  other = await createUser(pg)
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
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("sealed state", () => {
  it("keeps only the profile's site", () => {
    const scoped = scopeState(STATE, "fixture.test")
    expect(scoped.cookies.map((c) => c.name)).toEqual(["session"])
    expect(scoped.origins.map((o) => o.origin)).toEqual([
      "http://profile-editor.fixture.test",
    ])
  })

  it("AT-SEC-02 opens only for its own row and person", async () => {
    const id = await savedProfile()
    const row = await sealed(id)
    expect(row.state_sealed).not.toContain(COOKIE)
    expect(openState(user, id, row.state_sealed!).cookies[0].value).toBe(COOKIE)
    const elsewhere = await savedProfile(user, "example.com")
    expect(() => openState(user, elsewhere, row.state_sealed!)).toThrow()
    expect(() => openState(other, id, row.state_sealed!)).toThrow()
    // Moved onto another row, it doesn't open: that profile expires instead
    await pg.query("update kriya.login_profiles set state_sealed = $2 where id = $1", [
      elsewhere,
      row.state_sealed,
    ])
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await profileForTask({ userId: user }, "example.com")).toBeNull()
    expect(await sealed(elsewhere)).toEqual({ state_sealed: null, status: "expired" })
  })

  it("refuses a state too large to keep", () => {
    const big: StorageState = {
      cookies: [],
      origins: [
        {
          origin: "https://a.test",
          localStorage: [{ name: "x", value: "y".repeat(600_000) }],
        },
      ],
    }
    expect(() => sealState(user, "p", big)).toThrow(/too large/)
  })

  it("is opened only in lib/browser/profiles.ts; tokens only in lib/connectors.ts (invariant 4)", () => {
    const roots = ["lib", "actions", "app", "worker", "queries", "components", "db"]
    const files = roots.flatMap((root) =>
      fs
        .readdirSync(path.join(process.cwd(), root), {
          recursive: true,
          encoding: "utf8",
        })
        .filter((file) => /\.(ts|tsx)$/.test(file))
        .map((file) => path.join(root, file).replaceAll("\\", "/"))
    )
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")
    const opens = files.filter((file) =>
      /import\s*\{[^}]*\bopen\b[^}]*\}\s*from\s*["']@\/lib\/secrets["']/.test(read(file))
    )
    expect(opens.sort()).toEqual(["lib/browser/profiles.ts", "lib/connectors.ts"])
    const unseals = files.filter(
      (file) => file !== "lib/browser/profiles.ts" && /\bopenState\(/.test(read(file))
    )
    expect(unseals).toEqual([])
  })
})

describe("which profile a task may use", () => {
  it("AT-SCH-06 a scheduled run needs background use on both the profile and the schedule", async () => {
    const id = await savedProfile()
    await pg.query(
      `insert into kriya.schedules (id, user_id, agent_id, thread_id, kind, prompt, rule, approved_at, background_allowed)
       values ('s1', $1, 'a1', 't1', 'once', 'check', '{}', now(), false),
              ('s2', $1, 'a1', 't1', 'once', 'check', '{}', now(), true)`,
      [user]
    )
    const run = (scheduleId: string) =>
      profileForTask(
        { userId: user, input: { channel: "schedule", scheduleId } },
        "fixture.test"
      )
    expect(await run("s1")).toBeNull()
    expect(await run("s2")).toBeNull()
    await pg.query(
      "update kriya.login_profiles set background_allowed = true where id = $1",
      [id]
    )
    expect(await run("s1")).toBeNull()
    expect((await run("s2"))?.id).toBe(id)
    // Not someone else's schedule
    expect(
      await profileForTask(
        { userId: other, input: { channel: "schedule", scheduleId: "s2" } },
        "fixture.test"
      )
    ).toBeNull()
    // The person's own turn needs no background permission
    expect((await profileForTask({ userId: user }, "fixture.test"))?.id).toBe(id)
  })

  it("expires a profile past re-confirmation or unused for 90 days", async () => {
    const due = await savedProfile(
      user,
      "fixture.test",
      "expires_at = now() - interval '1 minute'"
    )
    expect(await profileForTask({ userId: user }, "fixture.test")).toBeNull()
    expect(await sealed(due)).toEqual({ state_sealed: null, status: "expired" })
    const unused = await savedProfile(
      user,
      "example.com",
      "confirmed_at = now() - interval '91 days', expires_at = now() + interval '1 day'"
    )
    expect(await profileForTask({ userId: user }, "example.com")).toBeNull()
    expect((await sealed(unused)).status).toBe("expired")
  })

  it("is never another person's", async () => {
    await savedProfile(other)
    expect(await profileForTask({ userId: user }, "fixture.test")).toBeNull()
  })
})

describe("a task with a saved login", () => {
  const browserFor = (fake: ProfileBrowser, profiles = true) =>
    new TaskBrowser(fake, { id: taskId, userId: user }, { profiles })

  it("loads the state for the first page's site and keeps the session there", async () => {
    const id = await savedProfile()
    const fake = new ProfileBrowser()
    const browser = browserFor(fake)
    await browser.act({
      action: "open",
      url: "http://profile-editor.fixture.test/account",
    })
    expect(fake.opened[0].state?.cookies[0].value).toBe(COOKIE)
    expect(fake.opened[0].allowedDomains).toEqual(["fixture.test"])
    expect(browser.loaded).toEqual({ domains: ["fixture.test"] })
    const { rows } = await pg.query(
      "select login_profile_id from kriya.browser_sessions where user_id = $1",
      [user]
    )
    expect(rows).toEqual([{ login_profile_id: id }])
    // Closing refreshes the saved state (active → active)
    const before = (await sealed(id)).state_sealed
    await browser.close()
    expect(fake.closes).toEqual([{ captureState: true }])
    const after = await sealed(id)
    expect(after.status).toBe("active")
    expect(after.state_sealed).not.toBe(before)
  })

  it("with the switch off, no state is ever loaded (AT-REG-01)", async () => {
    await savedProfile()
    const fake = new ProfileBrowser()
    const browser = browserFor(fake, false)
    await browser.act({
      action: "open",
      url: "http://profile-editor.fixture.test/account",
    })
    expect(fake.opened[0].state).toBeUndefined()
    expect(fake.opened[0].allowedDomains).toBeUndefined()
    await browser.close()
    expect(fake.closes).toEqual([{ captureState: false }])
  })

  it("the site signing the person out expires the login and says so", async () => {
    const id = await savedProfile()
    const fake = new ProfileBrowser()
    fake.signedOut = true
    const browser = browserFor(fake)
    const result = await browser.act({
      action: "open",
      url: "http://profile-editor.fixture.test/account",
    })
    expect(result).toMatchObject({ ok: false, error: "login_required" })
    expect(await sealed(id)).toEqual({ state_sealed: null, status: "expired" })
    // An expired login isn't refreshed on close
    await browser.close()
    expect(fake.closes).toEqual([{ captureState: false }])
  })

  it("AT-BRW-08 leaving the signed-in site is refused; typing on another site is R4", async () => {
    await savedProfile()
    const fake = new ProfileBrowser()
    const tools = createBrowserTools(browserFor(fake))
    expect(
      await call(tools.browser_open, { url: "http://injection.fixture.test/signed-in" })
    ).toMatchObject({ done: true })
    const away = await call(tools.browser_open, { url: "http://exfil.test/collect" })
    expect(away).toMatchObject({ done: false, class: "R3" })
    expect(fake.url).toBe("http://injection.fixture.test/signed-in")

    const profile = { domains: ["fixture.test"] }
    const offsite = {
      elements: [el("e9", { role: "textbox", name: "Message" })],
      facts: {
        url: "http://exfil.test/",
        domain: "exfil.test",
        hasForm: true,
        focusedSensitive: false,
        captcha: false,
      },
    }
    const onsite = { ...offsite, facts: { ...offsite.facts, domain: "fixture.test" } }
    const type: BrowserAction = { action: "type", ref: "e9", text: "private" }
    expect(classifyBrowserAction(type, offsite, null, profile)).toBe("R4")
    expect(classifyBrowserAction(type, onsite, null, profile)).toBe("R3")
    expect(classifyBrowserAction(type, offsite, null, null)).toBe("R3")
    const sub: BrowserAction = { action: "open", url: "https://www.fixture.test/x" }
    expect(classifyBrowserAction(sub, onsite, null, profile)).toBe("R0")
    const away2: BrowserAction = { action: "open", url: "https://exfil.test/" }
    expect(browserDecision(away2, onsite, null, profile).gate).toBe("refuse")
  })

  it("a login hand-off points the person at Account → Logins", async () => {
    const tools = createBrowserTools(browserFor(new ProfileBrowser()))
    await call(tools.browser_open, { url: "http://profile-editor.fixture.test/account" })
    const out = await call(tools.browser_handoff, { reason: "login", note: "Sign in" })
    expect(out.signIn).toMatch(/Account → Logins/)
  })
})

describe("take-over sign-in", () => {
  it("starts on the site, handed to the person, then saves only the site's state", async () => {
    const fake = new ProfileBrowser()
    const calls: string[] = []
    const act = fake.act.bind(fake)
    fake.act = async (id, action) => {
      calls.push(action.action)
      return act(id, action)
    }
    const started = await startSignIn(fake, user, {
      url: "http://profile-editor.fixture.test/login",
      label: "Work",
    })
    expect(started).toMatchObject({ domain: "fixture.test", mode: "read-only" })
    expect(calls).toEqual(["open", "handoff"])
    expect(fake.opened[0].state).toBeUndefined()
    const { rows } = await pg.query(
      "select status, task_id, login_profile_id from kriya.browser_sessions where id = $1",
      [started.sessionId]
    )
    expect(rows).toEqual([
      { status: "paused", task_id: null, login_profile_id: started.profileId },
    ])
    expect((await sealed(started.profileId)).status).toBe("pending")

    expect(await finishSignIn(fake, user, started.profileId, { save: true })).toBe(
      "saved"
    )
    const row = await sealed(started.profileId)
    expect(row.status).toBe("active")
    const kept = openState(user, started.profileId, row.state_sealed!)
    expect(kept.cookies.map((c) => c.domain)).toEqual([".fixture.test"])
    const { rows: usage } = await pg.query(
      "select quantity from kriya.resource_usage where request_key = $1",
      [`browser:${started.sessionId}`]
    )
    expect(usage).toEqual([{ quantity: 30 }])
  })

  it("saves nothing when nobody signed in, and discarding removes the pending login", async () => {
    const fake = new ProfileBrowser()
    fake.state = { cookies: [], origins: [] }
    const started = await startSignIn(fake, user, { url: "profile-editor.fixture.test" })
    expect(await finishSignIn(fake, user, started.profileId, { save: true })).toBe(
      "empty"
    )
    expect((await sealed(started.profileId)).status).toBe("pending")
    expect(await finishSignIn(fake, user, started.profileId, { save: false })).toBe(
      "discarded"
    )
    expect(await sealed(started.profileId)).toBeUndefined()
  })

  it("refuses addresses, other people's profiles and plans without logins", async () => {
    const fake = new ProfileBrowser()
    await expect(startSignIn(fake, user, { url: "http://10.0.0.1/" })).rejects.toThrow(
      /site's name/
    )
    const theirs = await savedProfile(other)
    await expect(
      startSignIn(fake, user, { url: "fixture.test", profileId: theirs })
    ).rejects.toThrow(/isn't yours/)
    await expect(finishSignIn(fake, user, theirs, { save: true })).rejects.toThrow(
      /isn't yours/
    )
    await pg.query("update kriya.plans set max_login_profiles = 0 where id = 'free'")
    await expect(startSignIn(fake, user, { url: "fixture.test" })).rejects.toThrow(
      /logins are all in use/
    )
    expect(fake.opened).toEqual([])
  })

  it("the janitor clears unfinished sign-ins and expired state", async () => {
    const fake = new ProfileBrowser()
    const started = await startSignIn(fake, user, { url: "fixture.test" })
    const stale = await savedProfile(
      user,
      "example.com",
      "expires_at = now() - interval '1 day'"
    )
    await pg.query(
      "update kriya.login_profiles set created_at = now() - interval '2 hours' where id = $1",
      [started.profileId]
    )
    await pg.query(
      "update kriya.browser_sessions set opened_at = now() - interval '1 hour' where id = $1",
      [started.sessionId]
    )
    expect(await profileJanitor()).toEqual({ expired: 1, abandoned: 1, resealed: 0 })
    expect(await sealed(started.profileId)).toBeUndefined()
    expect(await sealed(stale)).toEqual({ state_sealed: null, status: "expired" })
    const { rows } = await pg.query(
      "select status, seconds from kriya.browser_sessions where id = $1",
      [started.sessionId]
    )
    expect(rows).toEqual([{ status: "failed", seconds: 900 }])
  })
})

describe("AT-SEC-03 logs never carry session state", () => {
  const clean = __test.clean as (value: unknown) => unknown

  it("redacts cookies, Set-Cookie, storage-state JSON and sealed values", () => {
    expect(clean({ state: JSON.stringify(STATE) })).toEqual({ state: "[redacted]" })
    expect(clean({ storageState: STATE, cookies: STATE.cookies })).toEqual({
      storageState: "[redacted]",
      cookies: "[redacted]",
    })
    expect(
      clean({ headers: `HTTP/1.1 303\r\nSet-Cookie: session=${COOKIE}; HttpOnly` })
    ).toEqual({ headers: "HTTP/1.1 303\r\nSet-Cookie: [redacted]" })
    expect(clean({ detail: `cookie: session=${COOKIE}` })).toEqual({
      detail: "cookie: [redacted]",
    })
    const value = sealState(user, "p1", STATE)
    expect(JSON.stringify(clean({ note: `stored ${value}` }))).not.toContain(value)
    expect(clean({ stateSealed: "anything", localStorage: [] })).toEqual({
      stateSealed: "[redacted]",
      localStorage: "[redacted]",
    })
  })

  it("leaves ordinary fields alone", () => {
    const fields = {
      origin: "upload",
      domain: "fixture.test",
      version: "v1.2.3",
      message: "We use cookies to keep you signed in.",
      profileId: "8a4f",
    }
    expect(clean(fields)).toEqual(fields)
  })

  it("nothing a profile does writes its state or a password to the console", async () => {
    const lines: string[] = []
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "))
      })
    }
    const id = await savedProfile()
    // An unreadable state is logged (as a warning), without its contents
    await pg.query("update kriya.login_profiles set state_sealed = $2 where id = $1", [
      id,
      sealState(other, id, STATE),
    ])
    await profileForTask({ userId: user }, "fixture.test")
    log.error("debug", { state: STATE, raw: JSON.stringify(STATE), password: PASSWORD })
    const all = lines.join("\n")
    expect(lines.length).toBeGreaterThan(0)
    expect(all).not.toContain(COOKIE)
    expect(all).not.toContain(PASSWORD)
  })
})
