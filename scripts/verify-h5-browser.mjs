import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// H5 browser check (docs/kriya-harness/UX_SPEC.md §3: the Inbox harness
// approval) on the isolated P-3 stack only: local Supabase, local Next.js on
// :6796, local test user Asha with harness.api and agents.inbox on in the
// local platform_settings. A local test device (its token made here, only
// its sha256 stored) asks through the real HTTP route; the person answers
// in the browser; the device's long-poll must return the answer.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const API = `${APP_URL}/api/harness/v1`
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "kriya-harness", "H5")
fs.mkdirSync(OUT_DIR, { recursive: true })

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !process.env.DATABASE_URL?.includes("127.0.0.1")
)
  throw new Error("Export .env.verify (local stack) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const EMAIL = "asha@example.com"

async function getAuthCookies() {
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

// A fresh local test device for Asha; earlier H5 requests are cleared
async function device() {
  const [user] = await sql`select id from auth.users where email = ${EMAIL}`
  await sql`delete from kriya.harness_devices where user_id = ${user.id} and name = 'verify-laptop'`
  const token = randomBytes(32).toString("base64url")
  await sql`insert into kriya.harness_devices (user_id, name, platform, token_hash)
    values (${user.id}, 'verify-laptop', 'darwin', ${createHash("sha256").update(token).digest("hex")})`
  return token
}

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  "x-kriya-harness": "0.1.0",
  "content-type": "application/json",
})

async function ask(token, body) {
  const res = await fetch(`${API}/approvals`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  })
  if (res.status !== 201) throw new Error(`POST /approvals ${res.status}`)
  return res.json()
}

const statusOf = async (token, id, wait = 0) =>
  (await fetch(`${API}/approvals/${id}?wait=${wait}`, { headers: headers(token) })).json()

const REQUESTS = [
  {
    sessionRef: "verify-1",
    tool: "bash",
    summary: "Run the test suite",
    input: { command: "npm test", timeoutMs: 120000 },
    cwd: "/Users/dev/projects/kriya-demo",
  },
  {
    sessionRef: "verify-1",
    tool: "web_fetch",
    summary: "Fetch the deployment status",
    input: { url: "https://status.example.test", apiToken: "local-test-value" },
    cwd: "/Users/dev/projects/kriya-demo",
  },
]

const VIEWPORTS = [
  { name: "360", width: 360, height: 800 },
  { name: "1280", width: 1280, height: 800 },
]

async function shot(browser, cookies, { id, url, vp, theme, act }) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    colorScheme: theme,
  })
  await context.addCookies(cookies)
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
    await page.waitForTimeout(1200)
    const extra = act ? await act(page) : {}
    const noHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
    // The card's buttons: at least 44 px tall below the sm breakpoint
    const targets = await page
      .getByRole("button", { name: /Approve once|Decline/ })
      .evaluateAll((nodes) =>
        nodes.map((n) => Math.round(n.getBoundingClientRect().height))
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
      targets,
      ...extra,
    }
  } catch (error) {
    return { file: "—", screen: id, viewport: vp.name, theme, error: error.message }
  } finally {
    await context.close()
  }
}

async function run() {
  const cookies = await getAuthCookies()
  const token = await device()
  const asked = []
  for (const body of REQUESTS) asked.push(await ask(token, body))
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const results = []

  // 1. The cards, 360 and 1280, light and dark; the card text read back
  for (const vp of VIEWPORTS)
    for (const theme of ["light", "dark"])
      results.push(
        await shot(browser, cookies, {
          id: "01_inbox-harness-cards",
          url: `${APP_URL}/inbox`,
          vp,
          theme,
          act: async (page) => ({
            text: (await page.locator("li", { hasText: "web_fetch" }).first().innerText())
              .replace(/\s+/g, " ")
              .trim(),
          }),
        })
      )

  // 2. Approve once on the first while the device long-polls; Decline the second
  results.push(
    await shot(browser, cookies, {
      id: "02_answered",
      url: `${APP_URL}/inbox`,
      vp: VIEWPORTS[1],
      theme: "light",
      act: async (page) => {
        const started = Date.now()
        const poll = statusOf(token, asked[0].id, 20)
        await page.waitForTimeout(500)
        await page
          .locator("li", { hasText: "Run the test suite" })
          .getByRole("button", { name: "Approve once" })
          .click()
        const first = await poll
        const pollMs = Date.now() - started
        await page
          .locator("li", { hasText: "web_fetch" })
          .getByRole("button", { name: "Decline" })
          .click()
        await page.waitForTimeout(1500)
        return {
          longPoll: { ...first, ms: pollMs },
          second: await statusOf(token, asked[1].id),
          cardsLeft: await page.getByText("Your laptop agent wants to run").count(),
        }
      },
    })
  )

  // 3. A new request while the person is elsewhere: the notification card
  for (const theme of ["light", "dark"])
    results.push(
      await shot(browser, cookies, {
        id: "03_notification",
        url: `${APP_URL}/home`,
        vp: VIEWPORTS[0],
        theme,
        act: async (page) => {
          const made = await ask(token, { ...REQUESTS[0], summary: "Run the linter" })
          await page.getByText("wants to run bash").first().waitFor({ timeout: 15000 })
          const notified = await page.getByText("wants to run bash").count()
          // Answered from the terminal: the device cancels it
          await fetch(`${API}/approvals/${made.id}`, {
            method: "DELETE",
            headers: headers(token),
          })
          return { notified, canceled: await statusOf(token, made.id) }
        },
      })
    )

  // 4. Neighbours: the Inbox with nothing from the device, the home page
  for (const vp of VIEWPORTS)
    results.push(
      await shot(browser, cookies, {
        id: "04_neighbour-inbox-empty",
        url: `${APP_URL}/inbox`,
        vp,
        theme: "light",
      })
    )

  await browser.close()
  await sql.end()
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2))
  let readme = `# H5 browser check (2026-11-01)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, local test user Asha; \`harness.api\` and \`agents.inbox\` on in the local \`platform_settings\`; a local test device asks through \`POST /api/harness/v1/approvals\`. Full results in \`results.json\`.\n\n`
  readme += `| Screenshot | Screen | Viewport | Theme | Console errors | Failed requests | No h-scroll | Button heights |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`
  for (const r of results)
    readme += r.error
      ? `| — | ${r.screen} | ${r.viewport} | ${r.theme} | error: ${r.error} | | | |\n`
      : `| \`${r.file}\` | ${r.screen} | ${r.viewport} | ${r.theme} | ${r.consoleErrors.length} | ${r.failed.length} | ${r.noHScroll ? "pass" : "FAIL"} | ${r.targets.join(", ")} |\n`
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  console.log(JSON.stringify(results, null, 2))
}

run().catch(async (error) => {
  console.error(error)
  await sql.end()
  process.exit(1)
})
