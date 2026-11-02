import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// H6 browser check (docs/kriya-harness/UX_SPEC.md §3: the mirror thread and
// the Devices mirror choice) on the isolated P-3 stack only. The real Kriya
// Harness client (../kriya-harness) runs `kriya run` on the pinned DSH
// against the local Kriya server; its mirror plugin sends the turn; the
// person reads the thread and changes the mode as local test user Asha.
// The model upstream is a scripted stub on :6797 (no money, no provider).
//
//   node scripts/verify-h6-browser.mjs setup     (before starting web-verify)
//   node scripts/verify-h6-browser.mjs run
//   node scripts/verify-h6-browser.mjs restore
//
// `setup` writes local test values only, each removed by `restore`:
// harness.mirror and harness.gateway on, an exchange rate of 1 and a 1
// micro-USD price for the non-existent model stub/budget (fixtures, never
// real prices), the local free plan's harness limit and balanced tier.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CLIENT = path.resolve(process.cwd(), "..", "kriya-harness")
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "kriya-harness", "H6")
const EMAIL = "asha@example.com"
const DEVICE = "verify-mirror-laptop"
const STUB_MODEL = "stub/budget"
const KEYS = ["harness.gateway", "harness.mirror", "fx.usdInr"]

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !process.env.DATABASE_URL?.includes("127.0.0.1") ||
  !process.env.OPENROUTER_BASE_URL?.includes("127.0.0.1:6797")
)
  throw new Error("Export .env.verify (local stack, local stub) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const SAVED = path.join(os.tmpdir(), "kriya-h6-saved.json")

async function setup() {
  const [free] =
    await sql`select allowed_tiers, harness_monthly_micro_inr from kriya.plans where id = 'free'`
  const settings =
    await sql`select key, value from kriya.platform_settings where key in ${sql(KEYS)}`
  const [model] = await sql`select id from kriya.models where id = ${STUB_MODEL}`
  fs.writeFileSync(SAVED, JSON.stringify({ free, settings, model: Boolean(model) }))
  await sql`insert into kriya.platform_settings (key, value)
    values ('harness.gateway', 'on'), ('harness.mirror', 'on'), ('fx.usdInr', '1')
    on conflict (key) do update set value = excluded.value`
  await sql`update kriya.plans set allowed_tiers = array['budget', 'balanced'],
    harness_monthly_micro_inr = 500000000 where id = 'free'`
  await sql`insert into kriya.models (id, label, enabled, supports_tools,
      input_micro_usd_per_mtok, output_micro_usd_per_mtok)
    values (${STUB_MODEL}, 'Local stub (verification only)', true, true, 1, 1)
    on conflict (id) do nothing`
  console.log("setup: local test values written; start web-verify now")
}

async function restore() {
  const saved = JSON.parse(fs.readFileSync(SAVED, "utf8"))
  await sql`update kriya.plans set allowed_tiers = ${saved.free.allowed_tiers},
    harness_monthly_micro_inr = ${saved.free.harness_monthly_micro_inr} where id = 'free'`
  await sql`delete from kriya.platform_settings where key in ${sql(KEYS)}`
  for (const row of saved.settings)
    await sql`insert into kriya.platform_settings (key, value) values (${row.key}, ${row.value})`
  if (!saved.model) await sql`delete from kriya.models where id = ${STUB_MODEL}`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  fs.rmSync(SAVED)
  console.log("restore: local test values removed")
}

// The model upstream: one harmless bash call, then a closing line. DSH adds
// its own context as user messages after the person's, so the marker is
// looked for in any user message
function upstream() {
  const text = (content) =>
    typeof content === "string" ? content : JSON.stringify(content ?? "")
  return http
    .createServer((req, res) => {
      let raw = ""
      req.on("data", (part) => (raw += part))
      req.on("end", () => {
        const body = JSON.parse(raw || "{}")
        const at = body.messages.findLastIndex(
          (m) => m.role === "user" && text(m.content).includes("[verify:mirror]")
        )
        const step =
          at === -1
            ? -1
            : body.messages.slice(at + 1).filter((m) => m.role === "assistant").length
        const base = {
          id: "stub",
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
        }
        const delta =
          step === 0
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${randomBytes(4).toString("hex")}`,
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        description: "Count the files",
                        command: "ls | wc -l",
                      }),
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content:
                  "Checked the folder: it's empty, so there are no tests to fix yet. Next I'd add a `package.json`.",
              }
        const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
        res.writeHead(200, { "content-type": "text/event-stream" })
        send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })
        send({
          ...base,
          choices: [
            { index: 0, delta: {}, finish_reason: step === 0 ? "tool_calls" : "stop" },
          ],
        })
        send({
          ...base,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        res.end("data: [DONE]\n\n")
      })
    })
    .listen(6797, "127.0.0.1")
}

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

// A local test device for Asha working as her first agent, mirror on
async function device(home) {
  const [user] = await sql`select id from auth.users where email = ${EMAIL}`
  const [agent] =
    await sql`select id from kriya.agents where user_id = ${user.id} order by created_at limit 1`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  const token = randomBytes(32).toString("base64url")
  const [row] = await sql`insert into kriya.harness_devices
      (user_id, agent_id, name, platform, token_hash, mirror)
    values (${user.id}, ${agent.id}, ${DEVICE}, 'darwin',
      ${createHash("sha256").update(token).digest("hex")}, 'summary') returning id`
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(home, "device.json"),
    JSON.stringify({ url: APP_URL, token, deviceId: row.id }),
    { mode: 0o600 }
  )
  return { deviceId: row.id, agentId: agent.id }
}

function kriyaRun(home, prompt) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [path.join(CLIENT, "bin", "kriya.js"), "run", prompt],
      {
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-demo-")),
        env: { ...process.env, KRIYA_HOME: home },
      }
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
    child.on("exit", (code) => (clearTimeout(timer), done({ code, stdout, stderr })))
  })
}

async function shot(browser, jar, { id, url, vp, theme, act }) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    colorScheme: theme,
  })
  await context.addCookies(jar)
  await context.addInitScript(
    (dark) => localStorage.setItem("theme", dark ? "dark" : "light"),
    theme === "dark"
  )
  const page = await context.newPage()
  const consoleErrors = []
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !m.text().includes("React DevTools") &&
      consoleErrors.push(m.text())
  )
  const failed = []
  page.on(
    "response",
    (r) => r.status() >= 400 && failed.push(`${r.status()} ${new URL(r.url()).pathname}`)
  )
  try {
    await page.goto(url, { waitUntil: "load", timeout: 120000 })
    await page.waitForTimeout(1500)
    const extra = act ? await act(page) : {}
    const noHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
    const file = `${id}_${vp.name}_${theme}.png`
    await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: true })
    return {
      file,
      screen: id,
      viewport: vp.name,
      theme,
      consoleErrors,
      failed,
      noHScroll,
      ...extra,
    }
  } catch (error) {
    return { file: "—", screen: id, viewport: vp.name, theme, error: error.message }
  } finally {
    await context.close()
  }
}

const VIEWPORTS = [
  { name: "360", width: 360, height: 800 },
  { name: "1280", width: 1280, height: 800 },
]

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stub = upstream()
  const results = []
  let browser
  try {
    const home = path.join(os.tmpdir(), `kriya-h6-${Date.now()}`)
    const { deviceId, agentId } = await device(home)
    const outcome = await kriyaRun(home, "[verify:mirror] Fix the failing tests")
    const [session] =
      await sql`select id, thread_id, last_seq from kriya.harness_sessions where device_id = ${deviceId}`
    const stored = session
      ? await sql`select role, parts from kriya.messages where thread_id = ${session.thread_id}`
      : []
    const [thread] = session
      ? await sql`select title, agent_id from kriya.threads where id = ${session.thread_id}`
      : []
    results.push({
      step: "kriya run",
      exit: outcome.code,
      stdout: outcome.stdout.trim().slice(-200),
      thread: thread ?? null,
      lastSeq: session?.last_seq ?? null,
      messages: stored.map((m) => ({ role: m.role, text: m.parts[0]?.text })),
    })
    if (!session) throw new Error(`no mirror session\n${outcome.stderr.slice(-800)}`)

    const jar = await cookies()
    browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
    for (const vp of VIEWPORTS)
      for (const theme of ["light", "dark"])
        results.push(
          await shot(browser, jar, {
            id: "01_mirror-thread",
            url: `${APP_URL}/a/${agentId}/${session.thread_id}`,
            vp,
            theme,
            act: async (page) => ({
              text: (
                await page
                  .getByText("Mirrored from Kriya Harness")
                  .first()
                  .locator("xpath=../..")
                  .innerText()
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 400),
            }),
          })
        )
    for (const vp of VIEWPORTS)
      for (const theme of ["light", "dark"])
        results.push(
          await shot(browser, jar, {
            id: "02_devices-mirror-choice",
            url: `${APP_URL}/account`,
            vp,
            theme,
            act: async (page) => {
              const group = page.getByRole("radiogroup", {
                name: `Session mirror for ${DEVICE}`,
              })
              await group.scrollIntoViewIfNeeded()
              const heights = await group
                .getByRole("radio")
                .evaluateAll((nodes) =>
                  nodes.map((n) => Math.round(n.getBoundingClientRect().height))
                )
              const checked = await group
                .getByRole("radio", { checked: true })
                .innerText()
              return { heights, checked }
            },
          })
        )
    // Switching to Full in the browser changes the device's mode
    results.push(
      await shot(browser, jar, {
        id: "03_devices-switched-to-full",
        url: `${APP_URL}/account`,
        vp: VIEWPORTS[0],
        theme: "light",
        act: async (page) => {
          const group = page.getByRole("radiogroup", {
            name: `Session mirror for ${DEVICE}`,
          })
          await group.scrollIntoViewIfNeeded()
          await group.getByRole("radio", { name: "Full" }).click()
          await page.waitForTimeout(1500)
          const [row] =
            await sql`select mirror from kriya.harness_devices where id = ${deviceId}`
          return {
            storedMode: row.mirror,
            checked: await group.getByRole("radio", { checked: true }).innerText(),
          }
        },
      })
    )
  } finally {
    await browser?.close()
    stub.close()
    await sql.end()
  }
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
}

const step = process.argv[2]
const steps = { setup, run, restore }
if (!steps[step]) throw new Error("setup | run | restore")
await steps[step]()
if (step !== "run") await sql.end()
