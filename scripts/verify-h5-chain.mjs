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

// H5 end to end on the isolated P-3 stack, the closest local stand-in for a
// phone against staging: the real Kriya Harness client (../kriya-harness)
// and the pinned DeepSeek Harness run `kriya run` against the local Kriya
// server (:6796, real gateway, real approvals API, local Supabase); the
// model upstream is a scripted stub on :6797 (no money, no provider); the
// person answers in the real Inbox at 360 px as local test user Asha.
//
//   node scripts/verify-h5-chain.mjs setup     (before starting web-verify)
//   node scripts/verify-h5-chain.mjs run
//   node scripts/verify-h5-chain.mjs restore
//
// `setup` writes local test values only, each restored by `restore`: the
// gateway switch, an exchange rate of 1 and a 1 micro-USD price for the
// stub model (test fixtures for a model that doesn't exist, never real
// prices), the local free plan's harness limit and the balanced tier.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CLIENT = path.resolve(process.cwd(), "..", "kriya-harness")
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "kriya-harness", "H5", "chain")
const EMAIL = "asha@example.com"
const STUB_MODEL = "stub/budget"
const MARK = "kriya-approved-chain"

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !process.env.DATABASE_URL?.includes("127.0.0.1") ||
  !process.env.OPENROUTER_BASE_URL?.includes("127.0.0.1:6797")
)
  throw new Error("Export .env.verify (local stack, local stub) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const SAVED = path.join(os.tmpdir(), "kriya-h5-chain-saved.json")

async function setup() {
  const [free] =
    await sql`select allowed_tiers, harness_monthly_micro_inr from kriya.plans where id = 'free'`
  const settings =
    await sql`select key, value from kriya.platform_settings where key in ('harness.gateway', 'fx.usdInr')`
  const [model] = await sql`select id from kriya.models where id = ${STUB_MODEL}`
  fs.writeFileSync(SAVED, JSON.stringify({ free, settings, model: Boolean(model) }))
  await sql`insert into kriya.platform_settings (key, value) values ('harness.gateway', 'on'), ('fx.usdInr', '1')
    on conflict (key) do update set value = excluded.value`
  await sql`update kriya.plans set allowed_tiers = array['budget', 'balanced'], harness_monthly_micro_inr = 500000000 where id = 'free'`
  await sql`insert into kriya.models (id, label, enabled, supports_tools, input_micro_usd_per_mtok, output_micro_usd_per_mtok)
    values (${STUB_MODEL}, 'Local stub (verification only)', true, true, 1, 1) on conflict (id) do nothing`
  console.log("setup: local test values written; start web-verify now")
}

async function restore() {
  const saved = JSON.parse(fs.readFileSync(SAVED, "utf8"))
  await sql`update kriya.plans set allowed_tiers = ${saved.free.allowed_tiers}, harness_monthly_micro_inr = ${saved.free.harness_monthly_micro_inr} where id = 'free'`
  await sql`delete from kriya.platform_settings where key in ('harness.gateway', 'fx.usdInr')`
  for (const row of saved.settings)
    await sql`insert into kriya.platform_settings (key, value) values (${row.key}, ${row.value})`
  if (!saved.model) await sql`delete from kriya.models where id = ${STUB_MODEL}`
  await sql`delete from kriya.harness_devices where name = 'verify-chain-laptop'`
  fs.rmSync(SAVED)
  console.log("restore: local test values removed")
}

// The model upstream: a bash call that needs wider sandbox access, then a
// closing line. DSH adds its own context as user messages after the
// person's, so the marker is looked for in any user message
const seen = []
function upstream() {
  const text = (content) =>
    typeof content === "string" ? content : JSON.stringify(content ?? "")
  return http
    .createServer((req, res) => {
      let raw = ""
      req.on("data", (part) => (raw += part))
      req.on("end", () => {
        const body = JSON.parse(raw || "{}")
        seen.push(body)
        const at = body.messages.findLastIndex(
          (m) => m.role === "user" && text(m.content).includes("[verify:chain]")
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
                        description: "Print a marker",
                        command: `echo ${MARK}`,
                        sandbox_permissions: "danger-full-access",
                        justification: "This check needs the command to run unsandboxed.",
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "Finished the chain check." }
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: step === 0 ? "tool_calls" : "stop" }] })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
        )
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
    {
      cookies: { getAll: () => jar, setAll: (c) => jar.push(...c) },
    }
  )
  const verified = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  })
  if (verified.error) throw verified.error
  return jar.map((c) => ({ name: c.name, value: c.value, url: APP_URL }))
}

// A local test device for Asha, signed in on a throwaway Kriya home
async function device(home) {
  const [user] = await sql`select id from auth.users where email = ${EMAIL}`
  await sql`delete from kriya.harness_devices where name = 'verify-chain-laptop'`
  const token = randomBytes(32).toString("base64url")
  const [row] =
    await sql`insert into kriya.harness_devices (user_id, name, platform, token_hash)
    values (${user.id}, 'verify-chain-laptop', 'darwin', ${createHash("sha256").update(token).digest("hex")}) returning id`
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(home, "device.json"),
    JSON.stringify({ url: APP_URL, token, deviceId: row.id }),
    {
      mode: 0o600,
    }
  )
  return row.id
}

function kriyaRun(home, prompt) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [path.join(CLIENT, "bin", "kriya.js"), "run", prompt],
      {
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-ws-")),
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

async function answerInInbox(browser, jar, button, theme, label) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
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
  const card = page.locator("li", { hasText: "Your laptop agent wants to run" }).first()
  for (let i = 0; i < 30; i++) {
    await page.goto(`${APP_URL}/inbox`, { waitUntil: "load", timeout: 120000 })
    if (await card.count()) break
    await page.waitForTimeout(2000)
  }
  const text = (await card.innerText()).replace(/\s+/g, " ").trim()
  await page.screenshot({
    path: path.join(OUT_DIR, `${label}_inbox_360_${theme}.png`),
    fullPage: true,
  })
  await card.getByRole("button", { name: button }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({
    path: path.join(OUT_DIR, `${label}_answered_360_${theme}.png`),
    fullPage: true,
  })
  await context.close()
  return { text, consoleErrors }
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stub = upstream()
  const jar = await cookies()
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const results = []
  try {
    for (const [label, button, theme] of [
      ["01_approve", "Approve once", "light"],
      ["02_decline", "Decline", "dark"],
    ]) {
      const home = path.join(os.tmpdir(), `kriya-chain-${label}-${Date.now()}`)
      const deviceId = await device(home)
      seen.length = 0
      const running = kriyaRun(home, "[verify:chain] Run the check")
      const inbox = await answerInInbox(browser, jar, button, theme, label)
      const outcome = await running
      const [approval] =
        await sql`select status, tool, input, answered_at from kriya.harness_approval_requests where device_id = ${deviceId}`
      const usage =
        await sql`select status, tier, model from kriya.harness_usage where device_id = ${deviceId} order by created_at`
      const toolResult = JSON.stringify(
        seen.at(-1)?.messages?.filter((m) => m.role === "tool") ?? []
      )
      results.push({
        label,
        button,
        exit: outcome.code,
        stdout: outcome.stdout.trim().slice(-300),
        stderrPhoneLine:
          /needs your OK\. Waiting for your answer in Kriya on your phone\./.test(
            outcome.stderr
          ),
        stderrTail: outcome.stderr
          .replace(/[A-Za-z0-9_-]{43}/g, "<token>")
          .trim()
          .slice(-400),
        inboxCard: inbox.text,
        consoleErrors: inbox.consoleErrors,
        approval: approval && {
          status: approval.status,
          tool: approval.tool,
          command: approval.input?.command,
          answered: Boolean(approval.answered_at),
        },
        gatewayCalls: usage.map((u) => `${u.tier}→${u.model}: ${u.status}`),
        commandOutputInToolResult: new RegExp(`(?<!echo )${MARK}`).test(toolResult),
      })
    }
  } finally {
    await browser.close()
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
