import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { chromium } from "playwright-core"

// C7 browser check (docs/cloud-execution/UX_SPEC.md §6) on the isolated P-3
// stack only: local Supabase, local Next.js on :6796, local test user Asha,
// rows seeded locally. Same pattern as verify-u3-browser.mjs.

const SUPABASE_URL = "http://127.0.0.1:54321"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "cloud-execution", "C7")
const AGENT = "QYgNV-mShYHa"

fs.mkdirSync(OUT_DIR, { recursive: true })

// A one-time magic link from the local stack's admin API (the local secret
// key from .env.verify, exported first), verified into session cookies:
// no password involved
async function getAuthCookies() {
  if (
    !process.env.SUPABASE_SECRET_KEY ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1")
  )
    throw new Error("Export .env.verify (local stack) first")
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: "asha@example.com",
  })
  if (linkError) throw new Error("No magic link for Asha: " + linkError.message)
  const cookieList = []
  const client = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: { getAll: () => cookieList, setAll: (c) => cookieList.push(...c) },
  })
  const { data, error } = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  })
  if (error || !data.session)
    throw new Error("Could not sign in as Asha: " + error?.message)
  return cookieList.map((c) => ({ name: c.name, value: c.value, url: APP_URL }))
}

const thread = (id) => `${APP_URL}/a/${AGENT}/${id}`
const strip = (page) => page.getByRole("button", { name: "Cloud workspace" })

async function expandCards(page) {
  for (const label of ["open workspace", "read", "edit", "search files", "changes"]) {
    const card = page
      .locator("button", { hasText: new RegExp(`^.{0,4}${label}`) })
      .first()
    if (await card.count()) await card.click().catch(() => {})
  }
  for (const cmd of ["$ npm test", "$ npm run lint"]) {
    const card = page.locator("button", { hasText: cmd }).first()
    if (await card.count()) await card.click().catch(() => {})
  }
  await page.waitForTimeout(400)
}

const scrollTo = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll("main *")].find(
      (e) => e.children.length === 0 && e.textContent?.includes(t)
    )
    el?.scrollIntoView({ block: "center" })
  }, text)

// Each shot: a name and what to do before it
const SCREENS = [
  {
    id: "thread-cards",
    url: thread("c7paused0001"),
    before: async (p) => scrollTo(p, "open workspace"),
  },
  {
    id: "thread-cards-expanded",
    url: thread("c7paused0001"),
    before: async (p) => {
      await expandCards(p)
      await scrollTo(p, "$ npm test")
    },
  },
  {
    id: "thread-diff-and-approval",
    url: thread("c7paused0001"),
    before: async (p) => {
      await expandCards(p)
      const diff = p.getByRole("button", { name: "Show the diff" })
      if (await diff.count()) await diff.click()
      await scrollTo(p, "needs your ok")
    },
  },
  {
    id: "strip-paused-expanded",
    url: thread("c7paused0001"),
    before: async (p) => {
      await strip(p).click()
      await p.waitForTimeout(300)
    },
  },
  {
    id: "close-dialog",
    url: thread("c7paused0001"),
    before: async (p) => {
      await strip(p).click()
      await p.getByRole("button", { name: "Close workspace" }).click()
      await p.waitForTimeout(400)
    },
  },
  {
    id: "strip-running-expanded",
    url: thread("c7running001"),
    before: async (p) => strip(p).click(),
  },
  {
    id: "strip-failed-expanded",
    url: thread("c7failed0001"),
    before: async (p) => strip(p).click(),
  },
  {
    id: "strip-closing-expanded",
    url: thread("c7closing001"),
    before: async (p) => strip(p).click(),
  },
  {
    id: "usage",
    url: `${APP_URL}/usage`,
    before: async (p) => scrollTo(p, "Cloud workspace minutes"),
  },
  { id: "owner-cloud", url: `${APP_URL}/owner/cloud`, before: async () => {} },
  {
    id: "owner-config-cloud",
    url: `${APP_URL}/owner/config`,
    before: async (p) => scrollTo(p, "Cloud workspaces"),
  },
  {
    id: "owner-config-plan",
    url: `${APP_URL}/owner/config`,
    before: async (p) => scrollTo(p, "Cloud minutes / month"),
  },
  // Neighbours: a thread without a workspace, and the owner overview's nav
  { id: "neighbour-thread", url: thread("JTONtLdEKeXH"), before: async () => {} },
  { id: "neighbour-owner", url: `${APP_URL}/owner`, before: async () => {} },
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
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: theme,
        })
        await context.addCookies(cookies)
        await context.addInitScript((dark) => {
          localStorage.setItem("theme", dark ? "dark" : "light")
        }, theme === "dark")
        const page = await context.newPage()
        const consoleErrors = []
        page.on("console", (msg) => {
          if (msg.type() === "error" && !msg.text().includes("React DevTools"))
            consoleErrors.push(msg.text())
        })
        const failedRequests = []
        page.on("requestfailed", (req) => {
          const err = req.failure()?.errorText || ""
          if (err !== "net::ERR_ABORTED") failedRequests.push(`${req.url()}: ${err}`)
        })
        page.on("response", (res) => {
          if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`)
        })
        try {
          await page.goto(screen.url, { waitUntil: "load", timeout: 120000 })
          await page
            .locator(".animate-spin")
            .first()
            .waitFor({ state: "detached", timeout: 20000 })
            .catch(() => {})
          await page.waitForTimeout(1500)
          await screen.before(page)
          await page.waitForTimeout(500)
          const noHScroll = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
          // Targets inside the parts C7 added: the strip, workspace cards, dialogs
          const small =
            vp.name === "360"
              ? await page.evaluate(() => {
                  const out = []
                  for (const el of document.querySelectorAll(
                    'button, a, input, [role="button"]'
                  )) {
                    const r = el.getBoundingClientRect()
                    if (!r.width || !r.height) continue
                    if (r.width >= 44 && r.height >= 44) continue
                    const name = (el.getAttribute("aria-label") || el.innerText || "")
                      .trim()
                      .slice(0, 40)
                    out.push(
                      `${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`
                    )
                  }
                  return out
                })
              : []
          const file = `${String(index).padStart(2, "0")}_${screen.id}_${vp.name}_${theme}.png`
          await page.screenshot({ path: path.join(OUT_DIR, file) })
          results.push({
            file,
            screen: screen.id,
            viewport: vp.name,
            theme,
            consoleErrors,
            failedRequests,
            noHScroll,
            small,
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
  let readme = `# C7 browser check (2026-10-31)\n\n`
  readme += `Isolated P-3 stack only: local Supabase, local Next.js dev server on :6796, local test user Asha (\`asha@example.com\`), workspace rows and tool cards seeded locally (no provider, no model). Full results in \`results.json\`.\n\n`
  readme += `| Screenshot | Screen | Viewport | Theme | Console errors | Failed requests | No h-scroll | Under 44 px |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`
  for (const r of results) {
    readme += r.error
      ? `| — | ${r.screen} | ${r.viewport} | ${r.theme} | error: ${r.error} | | | |\n`
      : `| \`${r.file}\` | ${r.screen} | ${r.viewport} | ${r.theme} | ${r.consoleErrors.length} | ${r.failedRequests.length} | ${r.noHScroll ? "pass" : "FAIL"} | ${r.small.length} |\n`
  }
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  console.log(`${results.length} shots; README and results.json in ${OUT_DIR}`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
