import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"

import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// Browser check for the Home tidy-up, How to use Kriya and Remote Control, on
// the isolated P-3 stack only, as local test user Asha. Events go through the
// real POST /live route.
//
//   node scripts/verify-remote-browser.mjs setup     (before starting web-verify)
//   node scripts/verify-remote-browser.mjs run
//   node scripts/verify-remote-browser.mjs restore

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "kriya-harness", "remote-control")
const EMAIL = "asha@example.com"
const DEVICE = "verify-remote-laptop"
const KEYS = ["harness.api", "harness.remoteControl", "harness.controlCenter"]

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !process.env.DATABASE_URL?.includes("127.0.0.1")
)
  throw new Error("Export .env.verify (local stack) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

async function cookies() {
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  })
  if (error) throw error
  const jar = []
  const client = createServerClient(
    SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { cookies: { getAll: () => jar, setAll: (c) => jar.push(...c) } }
  )
  const verified = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  })
  if (verified.error) throw verified.error
  return jar.map((c) => ({ name: c.name, value: c.value, url: APP_URL }))
}

async function restore() {
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  await sql`delete from kriya.platform_settings where key in ${sql(KEYS)}`
  console.log("restore: local test values removed")
}

async function setup() {
  for (const key of KEYS)
    await sql`insert into kriya.platform_settings (key, value) values (${key}, 'on')
      on conflict (key) do update set value = 'on'`
  console.log("setup: switches on; start web-verify now")
}

// As the client sends on production: gzip+base64 past the host's firewall
async function report(token, body) {
  const res = await fetch(`${APP_URL}/api/harness/v1/live`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain; charset=us-ascii",
      "x-kriya-body": "gzip+base64",
      "x-kriya-harness": "0.2.0",
    },
    body: gzipSync(Buffer.from(JSON.stringify(body))).toString("base64"),
  })
  if (res.status !== 204) throw new Error(`POST /live answered ${res.status}`)
}

// The real client (../kriya-harness plugins/remote) into the real route
async function clientDelivers(token, userId) {
  const { remote } = await import(
    path.resolve(process.cwd(), "..", "kriya-harness", "plugins", "remote", "index.js")
  )
  const file = path.join(fs.mkdtempSync("/tmp/kriya-rc-"), "remote.json")
  const r = remote({
    device: () => ({ url: APP_URL, token }),
    file,
    flushMs: 100,
    external: () => true,
  })
  await r.set("session-client", { on: true }, { folder: process.cwd() })
  const at = Date.now()
  r.onEvent("session-client", {
    type: "user/message",
    time: at,
    data: {
      source: { kind: "user" },
      content: [{ type: "text", text: "From the client" }],
    },
  })
  r.onEvent("session-client", {
    type: "tool/call",
    time: at,
    data: { callId: "c", name: "bash", arguments: '{"command":"npm test"}' },
  })
  await new Promise((done) => setTimeout(done, 1500))
  await r.close()
  const rows = await sql`select e.kind from kriya.harness_live_events e
    join kriya.harness_live_sessions s on s.id = e.session_id
    where s.device_session_id = 'session-client' and s.user_id = ${userId} order by e.seq`
  const kinds = rows.map((row) => row.kind).join(",")
  if (kinds !== "user,tool_start")
    throw new Error(`client delivered: ${kinds || "nothing"}`)
  console.log("client → server delivery: ok")
}

// Controls under 44 px on a phone; links inside running text don't count
const smallTargets = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("main a, main button, [role=switch]")]
      .filter((el) => {
        const box = el.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && box.height < 44
      })
      .map((el) =>
        (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40)
      )
  )

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const [user] = await sql`select id from auth.users where email = ${EMAIL}`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  const token = randomBytes(32).toString("base64url")
  await sql`insert into kriya.harness_devices (user_id, name, platform, token_hash)
    values (${user.id}, ${DEVICE}, 'darwin', ${createHash("sha256").update(token).digest("hex")})`
  const now = Date.now()
  const base = {
    deviceSessionId: "session-verify",
    title: "Fix the login page",
    project: "my-app",
    remote: true,
  }
  await report(token, {
    ...base,
    state: "running",
    events: [
      { seq: 0, at: now, kind: "user", text: "Fix the login page" },
      {
        seq: 1,
        at: now,
        kind: "tool_start",
        callId: "a",
        tool: "edit",
        target: "src/login.tsx",
      },
      { seq: 2, at: now, kind: "tool_end", callId: "a", status: "ok", ms: 1200 },
      {
        seq: 3,
        at: now,
        kind: "tool_start",
        callId: "b",
        tool: "browser_open",
        target: "http://localhost:3000/login",
      },
    ],
  })
  const [session] =
    await sql`select id from kriya.harness_live_sessions where device_session_id = 'session-verify' and user_id = ${user.id}`

  await clientDelivers(token, user.id)

  const jar = await cookies()
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const failures = []
  const notes = new Set()
  for (const width of [360, 1280])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        colorScheme: theme,
      })
      await context.addCookies(jar)
      await context.addInitScript((t) => localStorage.setItem("theme", t), theme)
      const page = await context.newPage()
      const errors = []
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
      const visit = async (name, url, check) => {
        await page.goto(`${APP_URL}${url}`, { waitUntil: "load" })
        await page.waitForTimeout(1500)
        await page.screenshot({
          path: path.join(OUT_DIR, `${name}_${width}_${theme}.png`),
        })
        const wide = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        )
        if (wide) failures.push(`${name} ${width} ${theme}: scrolls sideways`)
        if (width === 360)
          for (const text of await smallTargets(page))
            notes.add(`${name}: "${text}" under 44 px`)
        const problem = await check()
        if (problem) failures.push(`${name} ${width} ${theme}: ${problem}`)
      }
      await visit("home", "/home", async () => {
        const text = await page.innerText("body")
        if (/Compare the best phones|Hand Kriya a job/i.test(text)) return "old text"
        return (await page.getByRole("link", { name: "How to use Kriya" }).count())
          ? null
          : "no How to use Kriya"
      })
      await visit("guide", "/guide", async () =>
        (await page.getByRole("heading", { name: "How to use Kriya" }).count())
          ? null
          : "no heading"
      )
      await visit("harness", "/harness", async () =>
        (await page.getByText("Fix the login page").count()) ? null : "session not listed"
      )
      await visit("live", `/harness/live/${session.id}`, async () => {
        const seq = 100 + width + (theme === "dark" ? 1 : 0)
        await report(token, {
          ...base,
          state: "waiting",
          events: [{ seq, at: Date.now(), kind: "assistant", text: `Live line ${seq}` }],
        })
        try {
          await page.getByText(`Live line ${seq}`).waitFor({ timeout: 8000 })
          await page.getByText("Waiting for you").waitFor({ timeout: 3000 })
        } catch {
          return "new event didn't appear"
        }
        await page.screenshot({
          path: path.join(OUT_DIR, `live-updated_${width}_${theme}.png`),
        })
        return (await page.getByText("src/login.tsx").count()) ? null : "no file line"
      })
      if (errors.length)
        failures.push(`${width} ${theme}: console ${errors[0].slice(0, 200)}`)
      await context.close()
    }
  await browser.close()
  for (const note of notes) console.log(`note: ${note}`)
  console.log(
    failures.length
      ? failures.join("\n")
      : "all checks passed: 4 pages × 360/1280 × light/dark"
  )
  process.exitCode = failures.length ? 1 : 0
}

await { setup, run, restore }[process.argv[2]]()
await sql.end()
