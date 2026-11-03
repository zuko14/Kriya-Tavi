import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// Composer attachments browser check, on the isolated P-3 stack only (local
// Supabase, local Next.js on :6796, local test user Asha). agents.files is
// switched on in the local platform_settings for the run and put back after.
// Screens: a thread whose message came with two files (chips in the
// transcript), the composer after a real upload through local Storage
// (chip ready, send enabled, nothing sent), and Account → Files as the
// neighbour. Seeded rows are removed at the end. Pattern of
// verify-sh7-browser.mjs.

const SUPABASE_URL = "http://127.0.0.1:54321"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "attachments")
const AGENT = "attach-v1"
const THREAD = "attach-v1-thread"
const FILE_A = "a77ac400-0000-4000-8000-0000000000a1"
const FILE_B = "a77ac400-0000-4000-8000-0000000000a2"

fs.mkdirSync(OUT_DIR, { recursive: true })

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !/@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL ?? "")
)
  throw new Error("Export .env.verify (local stack) and pass verify:guard first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

async function getAuthCookies() {
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
  return {
    cookies: cookieList.map((c) => ({ name: c.name, value: c.value, url: APP_URL })),
    userId: data.session.user.id,
  }
}

async function unseed(userId) {
  await sql`delete from kriya.threads where id = ${THREAD}`
  await sql`delete from kriya.agents where id = ${AGENT}`
  await sql`delete from kriya.files where id in (${FILE_A}, ${FILE_B})`
  // The file this run uploaded through the composer
  if (userId)
    await sql`delete from kriya.files where user_id = ${userId} and name = 'site-survey.txt'`
}

async function seed(userId) {
  await sql`insert into kriya.agents (id, user_id, name, role, glyph) values (${AGENT}, ${userId}, 'Meera', 'Paperwork helper', 'g-attach')`
  await sql`insert into kriya.threads (id, user_id, agent_id, title) values (${THREAD}, ${userId}, ${AGENT}, 'Rent agreement check')`
  const hash = "a".repeat(64)
  await sql`insert into kriya.files (id, user_id, name, mime, size_bytes, origin, status, sha256) values
    (${FILE_A}, ${userId}, 'rent-agreement-2026.pdf', 'application/pdf', 248000, 'upload', 'extracted', ${hash}),
    (${FILE_B}, ${userId}, 'meter-photo.jpg', 'image/jpeg', 910000, 'upload', 'extracted', ${hash})`
  const attachments = [
    { id: FILE_A, name: "rent-agreement-2026.pdf", mime: "application/pdf" },
    { id: FILE_B, name: "meter-photo.jpg", mime: "image/jpeg" },
  ]
  await sql`insert into kriya.messages (thread_id, id, user_id, role, parts, metadata, created_at) values
    (${THREAD}, 'u1', ${userId}, 'user', ${sql.json([{ type: "text", text: "Is the deposit clause fair, and does the meter reading match?" }])}, ${sql.json({ attachments })}, now() - interval '2 minutes'),
    (${THREAD}, 'a1', ${userId}, 'assistant', ${sql.json([{ type: "text", text: "I read both files. The deposit is two months' rent, refundable within 30 days of handover; that's usual. The meter photo shows 04,512 units, which matches clause 9." }])}, ${sql.json({ agentId: AGENT })}, now() - interval '1 minute')`
}

async function shoot(browser, cookies, screen, results) {
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
        await page.waitForTimeout(1500)
        const checks = (await screen.before(page)) ?? {}
        await page.waitForTimeout(400)
        const noHScroll = await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
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
        const file = `${String(results.length + 1).padStart(2, "0")}_${screen.id}_${vp.name}_${theme}.png`
        await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: false })
        results.push({
          file,
          screen: screen.id,
          viewport: vp.name,
          theme,
          ...checks,
          consoleErrors,
          failedRequests,
          noHScroll,
          small,
        })
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

async function run() {
  const { cookies, userId } = await getAuthCookies()
  const [before] =
    await sql`select value from kriya.platform_settings where key = 'agents.files'`
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const results = []
  const thread = `${APP_URL}/a/${AGENT}/${THREAD}`
  const upload = path.join(OUT_DIR, "site-survey.txt")
  fs.writeFileSync(
    upload,
    "Site survey, plot 14: soil firm, water table 6 m, no encroachment.\n"
  )
  try {
    await unseed(userId)
    await sql`insert into kriya.platform_settings (key, value) values ('agents.files', 'on')
      on conflict (key) do update set value = 'on'`
    await seed(userId)
    // The settings cache in the web process
    await new Promise((r) => setTimeout(r, 6000))
    await shoot(
      browser,
      cookies,
      {
        id: "thread-attachments",
        url: thread,
        before: async (page) => ({
          chips: await page
            .getByRole("list", { name: "Attached files" })
            .getByRole("link")
            .count(),
          paperclip: await page.getByRole("button", { name: "Attach files" }).count(),
        }),
      },
      results
    )
    await shoot(
      browser,
      cookies,
      {
        id: "composer-uploaded",
        url: thread,
        before: async (page) => {
          await page.locator('input[type="file"]').setInputFiles(upload)
          const chip = page.getByRole("list", { name: "Attached files" }).last()
          await chip.getByText("site-survey.txt").waitFor({ timeout: 30000 })
          await page.waitForFunction(
            () => !document.querySelector('[aria-label="Attached files"] .animate-spin'),
            null,
            { timeout: 30000 }
          )
          return {
            uploadedChip: await chip.getByText("site-survey.txt").count(),
            sendEnabled: await page.getByRole("button", { name: "Send" }).isEnabled(),
          }
        },
      },
      results
    )
    await shoot(
      browser,
      cookies,
      {
        id: "account-files-neighbour",
        url: `${APP_URL}/account`,
        before: async () => ({}),
      },
      results
    )
  } finally {
    await browser.close()
    await unseed(userId)
    if (before)
      await sql`update kriya.platform_settings set value = ${before.value} where key = 'agents.files'`
    else await sql`delete from kriya.platform_settings where key = 'agents.files'`
    await sql.end()
    fs.rmSync(upload, { force: true })
    fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2))
  }
  for (const r of results) console.log(JSON.stringify(r))
}

await run()
