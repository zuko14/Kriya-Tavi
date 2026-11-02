import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R9 browser check (RD-18, RC-5) on the isolated P-3 stack only: local
// Supabase and local Next.js on :6796; no worker or model is needed. Asha
// (local owner) and Ravi share a room. Asha reports Ravi's message, blocks
// him (his message collapses, he's listed under Blocked), the owner console
// shows the report with its copy, and the owner closes it; then the
// screens at 360 and 1280, light and dark, and Asha unblocks Ravi.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R9")
const SWITCHES = ["rooms.enabled"]
fs.mkdirSync(OUT_DIR, { recursive: true })

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !/@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL ?? "")
)
  throw new Error("Export .env.verify (local stack) and pass verify:guard first")

const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} })

async function localUser(email, name) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  let id = data.users.find((u) => u.email === email)?.id
  if (!id) {
    const made = await admin.auth.admin.createUser({ email, email_confirm: true })
    if (made.error) throw made.error
    id = made.data.user.id
  }
  await db`update kriya.profiles set display_name = ${name}, onboarded_at = coalesce(onboarded_at, now()) where id = ${id}`
  return id
}

async function cookiesFor(email) {
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
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

const checks = []
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail: String(detail) })
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`)
}
let shot = 1
const snap = async (page, id) => {
  const file = `${String(shot++).padStart(2, "0")}_${id}.png`
  // caret "initial": the default hides the caret by writing an inline style
  // on text fields, which React reports as a hydration mismatch when a shot
  // lands before hydration
  await page.screenshot({ path: path.join(OUT_DIR, file), caret: "initial" })
  return file
}

async function context(browser, cookies, { width = 1280, theme = "light" } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 800 },
    colorScheme: theme,
  })
  await ctx.addCookies(cookies)
  await ctx.addInitScript(
    (dark) => localStorage.setItem("theme", dark ? "dark" : "light"),
    theme === "dark"
  )
  const page = await ctx.newPage()
  page.consoleErrors = []
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !m.text().includes("React DevTools") &&
      page.consoleErrors.push(m.text())
  )
  return page
}

async function setting(page, key, value) {
  await page.goto(`${APP_URL}/owner/config`, { waitUntil: "load", timeout: 120000 })
  const input = page.locator(`[id="setting-${key}"]`)
  await input.scrollIntoViewIfNeeded()
  await input.fill(value)
  await page.locator("form", { has: input }).getByRole("button", { name: "Save" }).click()
  await page.waitForTimeout(1500)
}

async function run() {
  const asha = await localUser("asha@example.com", "Asha")
  const ravi = await localUser("ravi.r2check@example.com", "Ravi")
  const [ashaCookies, raviCookies] = [
    await cookiesFor("asha@example.com"),
    await cookiesFor("ravi.r2check@example.com"),
  ]
  const [{ n: owner }] =
    await db`select count(*)::int as n from kriya.platform_roles where user_id = ${asha} and role = 'owner'`
  check("setup: Asha is the local owner", owner === 1)
  await db`update kriya.rooms set status = 'archived'
           where status = 'active' and title like 'R_ check room'`
  await db`delete from kriya.person_blocks where blocker_id = ${asha}`
  const limitKey = (key) =>
    createHash("sha256").update(key).digest("base64url").slice(0, 32)
  await db`delete from kriya.rate_limits where key in ${db(
    [
      `rooms:invite:${asha}`,
      "rooms:join:ip:unknown",
      "rooms:join:ip:127.0.0.1",
      `rooms:report:${asha}`,
      `rooms:block:${asha}`,
    ].map(limitKey)
  )}`

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const A = await context(browser, ashaCookies)
  const B = await context(browser, raviCookies)
  for (const key of SWITCHES) await setting(A, key, "on")

  /* ── a room with Ravi; Ravi posts ── */
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "New room" }).click()
  await A.getByLabel("Name").fill("R9 check room")
  await A.getByRole("button", { name: "Create room" }).click()
  await A.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 })
  const roomUrl = A.url()
  const roomId = roomUrl.split("/").at(-1)
  await A.getByRole("button", { name: "Room info" }).click()
  await A.getByRole("button", { name: "Make a link" }).click()
  const code = A.locator("code", { hasText: "/rooms/join/" })
  await code.waitFor({ timeout: 15000 })
  const inviteUrl = (await code.innerText()).trim()
  await A.keyboard.press("Escape")
  await B.goto(inviteUrl, { waitUntil: "load" })
  await B.getByRole("button", { name: "Join the room" }).click()
  await B.waitForURL(roomUrl, { timeout: 30000 })
  await B.getByRole("textbox", { name: "Message" }).fill(
    "Cheap loans, call this number now"
  )
  await B.getByRole("button", { name: "Send" }).click()
  await B.getByText("Cheap loans, call this number now").waitFor({ timeout: 15000 })

  /* ── Asha reports it ── */
  await A.reload({ waitUntil: "load" })
  await A.getByText("Cheap loans, call this number now").waitFor({ timeout: 15000 })
  await A.getByRole("button", { name: "Report message" }).click()
  await A.getByRole("dialog").getByText("Spam or scam").click()
  await A.getByLabel("Details").fill("Looks like a scam")
  await snap(A, "report-dialog_1280_light")
  await A.getByRole("button", { name: "Send report" }).click()
  await A.getByText("Thanks. Kriya will look at it.", { exact: false }).waitFor({
    timeout: 15000,
  })
  const [report] = await db`select id, reason, note, message_body, message_user_id, status
    from kriya.room_reports where room_id = ${roomId} and reporter_id = ${asha}`
  check(
    "RT-MOD-03: the report is stored with the database's copy of the message",
    report &&
      report.reason === "spam" &&
      report.message_body === "Cheap loans, call this number now" &&
      report.message_user_id === ravi &&
      report.status === "open"
  )
  await A.getByRole("button", { name: "Done" }).click()

  /* ── Asha blocks Ravi; his message collapses for her only ── */
  await A.getByRole("button", { name: "Room info" }).click()
  await A.getByRole("dialog").getByRole("button", { name: "Block", exact: true }).click()
  await A.getByRole("alertdialog")
    .getByRole("button", { name: "Block", exact: true })
    .click()
  await A.getByText("Member · Blocked").waitFor({ timeout: 15000 })
  await snap(A, "room-info-blocked_1280_light")
  await A.keyboard.press("Escape")
  await A.getByText("Message from someone you blocked").waitFor({ timeout: 15000 })
  check(
    "RT-MOD-02: the blocked person's message collapses for the blocker",
    !(await A.getByText("Cheap loans, call this number now").isVisible())
  )
  await snap(A, "room-collapsed_1280_light")
  await A.getByRole("button", { name: "Show" }).click()
  check(
    "RT-MOD-02: Show opens it",
    await A.getByText("Cheap loans, call this number now").isVisible()
  )
  await B.reload({ waitUntil: "load" })
  check(
    "RT-MOD-02: Ravi isn't told and still sees the room as before",
    (await B.getByText("Cheap loans, call this number now").isVisible()) &&
      !(await B.getByText("blocked", { exact: false }).count())
  )
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  check(
    "RT-MOD-02: Rooms lists Ravi under Blocked",
    await A.getByText("Blocked · 1").isVisible()
  )

  /* ── the owner console ── */
  await A.goto(`${APP_URL}/owner/rooms`, { waitUntil: "load", timeout: 120000 })
  const card = A.locator("li", { hasText: "Looks like a scam" })
  check(
    "RC-5: the report reaches the owner console with its copy and note",
    (await card.getByText("Cheap loans, call this number now").isVisible()) &&
      (await card.getByText("Spam or scam").isVisible())
  )
  await snap(A, "owner-rooms-open_1280_light")
  await card.getByRole("button", { name: "Reviewed" }).click()
  await A.waitForTimeout(2000)
  const [closed] =
    await db`select status, reviewed_by from kriya.room_reports where id = ${report.id}`
  const [{ n: audited }] =
    await db`select count(*)::int as n from kriya.audit_events where target_id = ${report.id} and action = 'room_report.reviewed'`
  check(
    "RC-5: the owner closes it, audited",
    closed.status === "reviewed" && closed.reviewed_by === asha && audited === 1
  )

  /* ── screens at 360 and 1280, light and dark ── */
  const results = []
  for (const [id, cookies, open, url] of [
    ["room-collapsed", ashaCookies, null, roomUrl],
    ["room-info", ashaCookies, /^Room info/, roomUrl],
    ["report-dialog", raviCookies, "report", roomUrl],
    ["rooms-blocked", ashaCookies, null, `${APP_URL}/rooms`],
    ["owner-rooms", ashaCookies, null, `${APP_URL}/owner/rooms`],
    ["owner-cloud-neighbour", ashaCookies, null, `${APP_URL}/owner/cloud`],
  ])
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"]) {
        const page = await context(browser, cookies, { width, theme })
        try {
          const res = await page.goto(url, { waitUntil: "load", timeout: 120000 })
          await page.waitForTimeout(1500)
          if (open === "report") {
            await page.getByRole("button", { name: "Room info" }).click()
            await page.getByRole("button", { name: "Report room" }).click()
            await page.waitForTimeout(600)
          } else if (open) {
            await page.getByRole("button", { name: open }).click()
            await page.waitForTimeout(600)
          }
          const noHScroll = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
          const small = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main button, main a[href], main textarea, [role=dialog] button, [role=dialog] textarea, [role=dialog] label"
              ),
            ]
              .filter((el) => {
                const r = el.getBoundingClientRect()
                return r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 44)
              })
              .map((el) =>
                (el.getAttribute("aria-label") || el.textContent || el.tagName)
                  .trim()
                  .slice(0, 30)
              )
          )
          const file = await snap(page, `${id}_${width}_${theme}`)
          results.push({
            file,
            id,
            width,
            theme,
            status: res?.status(),
            consoleErrors: page.consoleErrors,
            noHScroll,
            small,
          })
        } catch (error) {
          results.push({ file: "—", id, width, theme, error: error.message })
        } finally {
          await page.context().close()
        }
      }

  /* ── unblock from Rooms ── */
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "Unblock" }).click()
  await A.waitForTimeout(2000)
  const [{ n: left }] =
    await db`select count(*)::int as n from kriya.person_blocks where blocker_id = ${asha}`
  check("RT-MOD-02: Unblock in Rooms removes the block", left === 0)

  const raviErrors = [...B.consoleErrors]
  await B.context().close()
  for (const key of SWITCHES) await setting(A, key, "")
  check(
    "flow pages: no console errors",
    A.consoleErrors.length + raviErrors.length === 0,
    [...A.consoleErrors, ...raviErrors].slice(0, 3).join(" | ")
  )
  await browser.close()
  await db.end()

  const token = inviteUrl.split("/").at(-1)
  const scrub = (s) => String(s).replaceAll(token, "<token>")
  fs.writeFileSync(
    path.join(OUT_DIR, "results.json"),
    scrub(JSON.stringify({ checks, results }, null, 2))
  )
  let readme = `# R9 browser check (2026-11-01)\n\nIsolated P-3 stack only: local Supabase and local Next.js on :6796 (no worker, no model). Local test users Asha (local owner) and Ravi; ${SWITCHES.join(", ")} on for the flow and cleared at the end.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
  for (const c of checks)
    readme += `| ${c.name} | ${c.ok ? "pass" : "FAIL"} | ${scrub(c.detail).replace(/\|/g, "/")} |\n`
  readme += `\n## Screens\n\n| Screenshot | Screen | Width | Theme | Status | Console errors | No h-scroll | Targets < 44 px |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`
  for (const r of results)
    readme += r.error
      ? `| — | ${r.id} | ${r.width} | ${r.theme} | error: ${scrub(r.error)} | | | |\n`
      : `| \`${r.file}\` | ${r.id} | ${r.width} | ${r.theme} | ${r.status} | ${r.consoleErrors.length} | ${r.noHScroll ? "pass" : "FAIL"} | ${r.small.length ? r.small.join(", ") : "none"} |\n`
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  console.log(`${results.length} screen shots in ${OUT_DIR}`)
  if (checks.some((c) => !c.ok) || results.some((r) => r.error)) process.exit(1)
}

run().catch(async (error) => {
  console.error(error)
  await db.end().catch(() => {})
  process.exit(1)
})
