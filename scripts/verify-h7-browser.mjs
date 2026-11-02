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

// H7 check on the isolated P-3 stack only: the real Kriya Harness client
// (../kriya-harness) runs `kriya run` on the pinned DSH against the local
// Kriya server; the scripted model saves a note with kriya_memory_save,
// searches with kriya_memory_search and loads a curated Kriya skill through
// DSH's own `skill` tool; the note must wait, unconfirmed, under Inbox →
// Memories to review for local test user Asha (360/1280, light/dark). The
// model upstream is a scripted stub on :6797 (no money, no provider).
//
//   node scripts/verify-h7-browser.mjs setup     (before starting web-verify)
//   node scripts/verify-h7-browser.mjs run
//   node scripts/verify-h7-browser.mjs restore
//
// `setup` writes local test values only, each removed by `restore`:
// agents.memoryV2, agents.skillLibrary and harness.gateway on, an exchange
// rate of 1 and a 1 micro-USD price for the non-existent model stub/budget
// (fixtures, never real prices), the local free plan's harness limit and
// balanced tier.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CLIENT = path.resolve(process.cwd(), "..", "kriya-harness")
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "kriya-harness", "H7")
const EMAIL = "asha@example.com"
const DEVICE = "verify-skills-laptop"
const NOTE = "This project uses pnpm, not npm (saved from the laptop)."
const SKILL = "verification-before-completion"
const STUB_MODEL = "stub/budget"
const KEYS = ["harness.gateway", "agents.memoryV2", "agents.skillLibrary", "fx.usdInr"]

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !process.env.DATABASE_URL?.includes("127.0.0.1") ||
  !process.env.OPENROUTER_BASE_URL?.includes("127.0.0.1:6797")
)
  throw new Error("Export .env.verify (local stack, local stub) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const SAVED = path.join(os.tmpdir(), "kriya-h7-saved.json")

async function setup() {
  const [free] =
    await sql`select allowed_tiers, harness_monthly_micro_inr from kriya.plans where id = 'free'`
  const settings =
    await sql`select key, value from kriya.platform_settings where key in ${sql(KEYS)}`
  const [model] = await sql`select id from kriya.models where id = ${STUB_MODEL}`
  fs.writeFileSync(SAVED, JSON.stringify({ free, settings, model: Boolean(model) }))
  await sql`insert into kriya.platform_settings (key, value)
    values ('harness.gateway', 'on'), ('agents.memoryV2', 'on'),
      ('agents.skillLibrary', 'on'), ('fx.usdInr', '1')
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
  await sql`delete from kriya.memories where content = ${NOTE}`
  fs.rmSync(SAVED)
  console.log("restore: local test values removed")
}

// The model upstream: save a note, search, load a Kriya skill, then a
// closing line. The step is the number of tool results so far; DSH's own
// title request (no tools offered) gets a plain answer
const seen = []
function upstream() {
  const steps = [
    { name: "kriya_memory_save", arguments: { content: NOTE } },
    { name: "kriya_memory_search", arguments: { query: "pnpm" } },
    { name: "skill", arguments: { name: SKILL } },
  ]
  return http
    .createServer((req, res) => {
      let raw = ""
      req.on("data", (part) => (raw += part))
      req.on("end", () => {
        const body = JSON.parse(raw || "{}")
        const done = body.messages.filter((m) => m.role === "tool").length
        const step = body.tools?.length && done < steps.length ? steps[done] : null
        if (body.tools?.length) seen.push(body)
        const base = {
          id: "stub",
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
        }
        const delta = step
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${randomBytes(4).toString("hex")}`,
                  type: "function",
                  function: {
                    name: step.name,
                    arguments: JSON.stringify(step.arguments),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: body.tools?.length
                ? "Saved the note and checked the skill."
                : "Skills check",
            }
        const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
        res.writeHead(200, { "content-type": "text/event-stream" })
        send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })
        send({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }],
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

// A local test device for Asha working as her first agent
async function device(home) {
  const [user] = await sql`select id from auth.users where email = ${EMAIL}`
  const [agent] =
    await sql`select id from kriya.agents where user_id = ${user.id} order by created_at limit 1`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  const token = randomBytes(32).toString("base64url")
  const [row] = await sql`insert into kriya.harness_devices
      (user_id, agent_id, name, platform, token_hash, mirror)
    values (${user.id}, ${agent.id}, ${DEVICE}, 'darwin',
      ${createHash("sha256").update(token).digest("hex")}, 'off') returning id`
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
    const home = path.join(os.tmpdir(), `kriya-h7-${Date.now()}`)
    await sql`delete from kriya.memories where content = ${NOTE}`
    const { agentId } = await device(home)
    const outcome = await kriyaRun(home, "Check my notes and skills")
    const [note] =
      await sql`select agent_id, trust, source from kriya.memories where content = ${NOTE}`
    const tools = JSON.stringify(
      seen.at(-1)?.messages?.filter((m) => m.role === "tool") ?? []
    )
    results.push({
      step: "kriya run",
      exit: outcome.code,
      stdout: outcome.stdout.trim().slice(-200),
      note: note ?? null,
      noteForDeviceAgent: note?.agent_id === agentId,
      searchReachedModel: tools.includes("pnpm"),
      skillLoaded:
        tools.includes(`skill_content name=\\"${SKILL}\\"`) &&
        tools.includes("skill_instructions"),
      skillChars: (
        /<skill_instructions>([\s\S]*?)<\/skill_instructions>/.exec(
          JSON.parse(tools || "[]")
            .map((m) => m.content)
            .join("\n")
        )?.[1] ?? ""
      ).length,
    })
    if (!note) throw new Error(`no note saved\n${outcome.stderr.slice(-800)}`)

    const jar = await cookies()
    browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
    for (const vp of VIEWPORTS)
      for (const theme of ["light", "dark"])
        results.push(
          await shot(browser, jar, {
            id: "01_inbox-memory-to-review",
            url: `${APP_URL}/inbox?show=memories`,
            vp,
            theme,
            act: async (page) => {
              const card = page.locator("li", { hasText: NOTE }).first()
              await card.scrollIntoViewIfNeeded()
              return { text: (await card.innerText()).replace(/\s+/g, " ").trim() }
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
