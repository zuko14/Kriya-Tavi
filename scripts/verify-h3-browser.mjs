import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { chromium } from "playwright-core"

// H3 browser check (docs/kriya-harness/UX_SPEC.md §3: usage line, owner plan
// field) on the isolated P-3 stack only: local Supabase, local Next.js on
// :6796, local test user Asha, the local free plan's harness limit and a
// few harness_usage rows seeded in the local database.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "kriya-harness", "H3")
fs.mkdirSync(OUT_DIR, { recursive: true })

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1")
)
  throw new Error("Export .env.verify (local stack) first")

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

const SCREENS = [
  {
    id: "usage-harness-line",
    url: `${APP_URL}/usage`,
    anchor: "Kriya Harness this month",
  },
  {
    id: "owner-plan-harness-limit",
    url: `${APP_URL}/owner/config`,
    anchor: "Kriya Harness limit",
  },
  // Neighbours: the usage page's other numbers, the account page
  { id: "neighbour-account", url: `${APP_URL}/account`, anchor: null },
]

async function run() {
  const cookies = await getAuthCookies()
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const results = []
  let index = 1
  for (const screen of SCREENS)
    for (const vp of [
      { name: "360", width: 360, height: 800 },
      { name: "1280", width: 1280, height: 800 },
    ])
      for (const theme of ["light", "dark"]) {
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
          await page.goto(screen.url, { waitUntil: "load", timeout: 120000 })
          await page.waitForTimeout(1200)
          let text = null
          if (screen.anchor) {
            const node = page.getByText(screen.anchor).first()
            await node.scrollIntoViewIfNeeded()
            text = (await node.locator("xpath=..").innerText())
              .replace(/\s+/g, " ")
              .trim()
          }
          const noHScroll = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
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
            text,
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
  await browser.close()
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2))
  let readme = `# H3 browser check (2026-10-31)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, local test user Asha; the local free plan's harness limit set to ₹500 and three harness_usage rows seeded (₹4.25 charged, ₹3.00 reserved and unpriced, one failed). Full results in \`results.json\`.\n\n`
  readme += `| Screenshot | Screen | Viewport | Theme | Console errors | Failed requests | No h-scroll | Text read |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`
  for (const r of results)
    readme += r.error
      ? `| — | ${r.screen} | ${r.viewport} | ${r.theme} | error: ${r.error} | | | |\n`
      : `| \`${r.file}\` | ${r.screen} | ${r.viewport} | ${r.theme} | ${r.consoleErrors.length} | ${r.failed.length} | ${r.noHScroll ? "pass" : "FAIL"} | ${r.text ?? ""} |\n`
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  console.log(`${results.length} shots in ${OUT_DIR}`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
