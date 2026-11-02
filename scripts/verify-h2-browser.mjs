import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { chromium } from "playwright-core"

// H2 browser check (docs/kriya-harness/UX_SPEC.md §3) on the isolated P-3
// stack only: local Supabase, local Next.js on :6796, local test user Asha,
// harness.api switched on in the local platform_settings. Device codes come
// from the local API, as the command-line client would ask for them.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "kriya-harness", "H2")
fs.mkdirSync(OUT_DIR, { recursive: true })

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1")
)
  throw new Error("Export .env.verify (local stack) first")

// A one-time magic link from the local admin API, verified into cookies
async function getAuthCookies() {
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: "asha@example.com",
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

let address = 0
// What `kriya login` does first; a distinct test address each time (10 an hour per address)
async function newCode(deviceName = "Asha MacBook", platform = "darwin") {
  const res = await fetch(`${APP_URL}/api/harness/v1/device/code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kriya-harness": "0.1.0",
      "x-forwarded-for": `198.51.100.${++address}`,
    },
    body: JSON.stringify({ deviceName, platform, clientVersion: "0.1.0" }),
  })
  if (!res.ok) throw new Error(`device/code ${res.status}`)
  return res.json()
}

async function pollToken(deviceCode) {
  const res = await fetch(`${APP_URL}/api/harness/v1/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kriya-harness": "0.1.0" },
    body: JSON.stringify({ deviceCode }),
  })
  return res.status
}

const psql = (sql) =>
  execFileSync("docker", [
    "exec",
    "supabase_db_Kriya-Tavi",
    "psql",
    "-U",
    "postgres",
    "-At",
    "-c",
    sql,
  ]).toString()

const SCREENS = [
  { id: "connect-entry", url: () => `${APP_URL}/connect/device`, before: async () => {} },
  {
    id: "connect-open",
    url: async () => `${APP_URL}/connect/device?code=${(await newCode()).userCode}`,
    before: async () => {},
  },
  {
    id: "connect-approved",
    url: async (ctx) => {
      ctx.flow = await newCode("Work laptop", "linux")
      return `${APP_URL}/connect/device?code=${ctx.flow.userCode}`
    },
    before: async (page, ctx) => {
      await page.getByRole("button", { name: "Approve" }).click()
      await page.getByText("You can close this tab").waitFor({ timeout: 15000 })
      ctx.tokenStatus = await pollToken(ctx.flow.deviceCode)
    },
  },
  {
    id: "connect-denied",
    url: async () => `${APP_URL}/connect/device?code=${(await newCode()).userCode}`,
    before: async (page) => {
      await page.getByRole("button", { name: "Deny" }).click()
      await page.getByText("Denied.").waitFor({ timeout: 15000 })
    },
  },
  {
    id: "connect-expired",
    url: async () => {
      const flow = await newCode()
      psql(
        `update kriya.harness_device_codes set expires_at = now() - interval '1 second' where user_code = '${flow.userCode.replace("-", "")}'`
      )
      return `${APP_URL}/connect/device?code=${flow.userCode}`
    },
    before: async () => {},
  },
  {
    id: "devices",
    url: () => `${APP_URL}/account#devices`,
    before: async (page) => {
      await page.locator("#devices").scrollIntoViewIfNeeded()
    },
  },
  {
    id: "devices-rename",
    url: () => `${APP_URL}/account#devices`,
    before: async (page) => {
      await page
        .locator("#devices")
        .getByRole("button", { name: "Rename" })
        .first()
        .click()
      await page.getByRole("dialog").waitFor()
    },
  },
  {
    id: "devices-revoke",
    url: () => `${APP_URL}/account#devices`,
    before: async (page) => {
      await page
        .locator("#devices")
        .getByRole("button", { name: "Revoke" })
        .first()
        .click()
      await page.getByRole("alertdialog").waitFor()
    },
  },
  {
    id: "owner-config-harness",
    url: () => `${APP_URL}/owner/config`,
    before: async (page) => {
      await page.getByRole("heading", { name: "Kriya Harness" }).scrollIntoViewIfNeeded()
    },
  },
]

async function run() {
  const cookies = await getAuthCookies()
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const results = []
  let index = 1
  for (const screen of SCREENS) {
    for (const vp of [
      { name: "360", width: 360, height: 800 },
      { name: "1280", width: 1280, height: 800 },
    ]) {
      for (const theme of ["light", "dark"]) {
        const ctx = {}
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
          (r) =>
            r.status() >= 400 && failed.push(`${r.status()} ${new URL(r.url()).pathname}`)
        )
        try {
          await page.goto(await screen.url(ctx), { waitUntil: "load", timeout: 120000 })
          await page.waitForTimeout(1200)
          await screen.before(page, ctx)
          await page.waitForTimeout(400)
          const noHScroll = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
          const small =
            vp.name === "360"
              ? await page.evaluate(() =>
                  [
                    ...document.querySelectorAll(
                      'button, a, input, select, [role="button"]'
                    ),
                  ]
                    .map((el) => ({ el, r: el.getBoundingClientRect() }))
                    .filter(
                      ({ r }) => r.width && r.height && (r.width < 44 || r.height < 44)
                    )
                    .map(
                      ({ el, r }) =>
                        `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`
                    )
                )
              : []
          const file = `${String(index).padStart(2, "0")}_${screen.id}_${vp.name}_${theme}.png`
          await page.screenshot({ path: path.join(OUT_DIR, file) })
          results.push({
            file,
            screen: screen.id,
            viewport: vp.name,
            theme,
            consoleErrors,
            failed,
            noHScroll,
            small,
            tokenStatus: ctx.tokenStatus,
          })
          index++
        } catch (error) {
          results.push({
            file: "—",
            screen: screen.id,
            viewport: vp.name,
            theme,
            error: error.message,
          })
        } finally {
          await context.close()
        }
      }
    }
  }
  await browser.close()
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2))
  let readme = `# H2 browser check (2026-10-31)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, local test user Asha (\`asha@example.com\`), \`harness.api\` on in the local platform_settings; device codes from the local API. Full results in \`results.json\`.\n\n`
  readme += `| Screenshot | Screen | Viewport | Theme | Console errors | Failed requests | No h-scroll | Under 44 px |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`
  for (const r of results)
    readme += r.error
      ? `| — | ${r.screen} | ${r.viewport} | ${r.theme} | error: ${r.error} | | | |\n`
      : `| \`${r.file}\` | ${r.screen} | ${r.viewport} | ${r.theme} | ${r.consoleErrors.length} | ${r.failed.length} | ${r.noHScroll ? "pass" : "FAIL"} | ${r.small.length} |\n`
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  console.log(`${results.length} shots in ${OUT_DIR}`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
