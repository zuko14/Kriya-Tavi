import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R8 browser check (docs/rooms/UX_SPEC.md §2, RD-14) on the isolated P-3
// stack only: local Supabase, local Next.js on :6796, the local worker and
// the stub model (no model cost). Asha (local owner) with her agent Lekha,
// and Ravi. Lekha saves a note (unconfirmed), Ravi confirms it in Notes and
// adds his own, the next request to Lekha carries both, and the owner's
// thread shows the tool card; then the screens at 360 and 1280, light and
// dark.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R8")
const AGENT = "verify-r4-lekha"
const SWITCHES = ["rooms.enabled", "rooms.agents", "agents.inbox"]
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

// The room's message list, as text
const listed = (page) => page.getByRole("list").first()

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
  const limitKey = (key) =>
    createHash("sha256").update(key).digest("base64url").slice(0, 32)
  await db`delete from kriya.rate_limits where key in ${db(
    [
      `rooms:invite:${asha}`,
      "rooms:join:ip:unknown",
      "rooms:join:ip:127.0.0.1",
      `rooms:note:${ravi}`,
    ].map(limitKey)
  )}`
  await db`insert into kriya.agents (id, user_id, name, role, glyph)
           values (${AGENT}, ${asha}, 'Lekha', 'Researcher', ${AGENT})
           on conflict (id) do nothing`

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const A = await context(browser, ashaCookies)
  const B = await context(browser, raviCookies)
  for (const key of SWITCHES) await setting(A, key, "on")

  /* ── a room with Ravi and Lekha ── */
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "New room" }).click()
  await A.getByLabel("Name").fill("R8 check room")
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
  await A.reload({ waitUntil: "load" })
  await A.getByRole("button", { name: "Agents" }).click()
  await A.getByLabel("Agent to add").selectOption({ label: "Lekha" })
  await A.getByRole("button", { name: "Add to room" }).click()
  await A.getByText("Your agent", { exact: false }).waitFor({ timeout: 15000 })
  await A.keyboard.press("Escape")

  /* ── Lekha saves a note ── */
  const box = A.getByRole("textbox", { name: "Message" })
  await box.fill("@Lekha [verify:room-note] keep the venue in view")
  await A.getByRole("button", { name: "Send" }).click()
  await listed(A)
    .getByText("Lekha added a note; a member can confirm it in Notes.")
    .waitFor({ timeout: 90000 })
  const [saved] =
    await db`select confirmed_by from kriya.room_notes where room_id = ${roomId} and author_kind = 'agent'`
  check(
    "RT-NOTE-01: the agent's note is saved unconfirmed",
    saved && saved.confirmed_by === null
  )
  await snap(A, "note-line_1280_light")

  /* ── Ravi confirms it and adds his own ── */
  await B.reload({ waitUntil: "load" })
  await B.getByRole("button", { name: /^Notes, 1 to confirm/ }).click()
  await B.getByText("not confirmed yet", { exact: false }).waitFor({ timeout: 10000 })
  await snap(B, "notes-unconfirmed_1280_light")
  await B.getByRole("button", { name: "Confirm" }).click()
  await B.getByText("confirmed by Ravi", { exact: false }).waitFor({ timeout: 15000 })
  check("RT-NOTE-01: a member confirms it as themselves", true)
  await B.getByLabel("New note").fill("Budget is ₹2 lakh.")
  await B.getByRole("button", { name: "Add note" }).click()
  await B.getByText("Budget is ₹2 lakh.").waitFor({ timeout: 15000 })
  await snap(B, "notes-confirmed_1280_light")
  await B.keyboard.press("Escape")

  /* ── the next request carries both ── */
  await box.fill("@Lekha [verify:room-reply] plan the day")
  await A.getByRole("button", { name: "Send" }).click()
  await A.waitForFunction(
    () => (document.body.innerText.match(/Lekha · AI · Asha's agent/g) ?? []).length >= 2,
    null,
    { timeout: 90000 }
  )
  const [request] = await db`select m.parts from kriya.messages m
    join kriya.room_agents a on a.bridge_thread_id = m.thread_id
    where a.room_id = ${roomId} and a.agent_id = ${AGENT} and m.role = 'user'
    order by m.created_at desc limit 1`
  const text = JSON.stringify(request?.parts ?? "")
  check(
    "RT-NOTE-02: the next request quotes the confirmed note and Ravi's note",
    text.includes("Confirmed room notes:") &&
      text.includes("The launch venue is Hall B.") &&
      text.includes("Budget is ₹2 lakh.")
  )
  const [{ n: copied }] = await db`select count(*)::int as n from kriya.memories
    where content like '%Hall B%' or content like '%2 lakh%'`
  check("RT-NOTE-02: nothing was copied into anyone's memory", copied === 0)

  /* ── the tool card in the owner's thread ── */
  const [bridge] = await db`select bridge_thread_id as id from kriya.room_agents
    where room_id = ${roomId} and agent_id = ${AGENT}`
  await A.goto(`${APP_URL}/a/${AGENT}/${bridge.id}`, { waitUntil: "load" })
  await A.getByText("note for the room", { exact: false })
    .first()
    .waitFor({ timeout: 15000 })
  check("R8: the owner's thread labels the tool run", true)
  await snap(A, "owner-thread-note_1280_light")

  /* ── screens at 360 and 1280, light and dark ── */
  const results = []
  for (const [id, cookies, open, url] of [
    ["room-with-notes", raviCookies, null, roomUrl],
    ["notes-dialog", raviCookies, /^Notes/, roomUrl],
    ["owner-thread", ashaCookies, null, `${APP_URL}/a/${AGENT}/${bridge.id}`],
  ])
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"]) {
        const page = await context(browser, cookies, { width, theme })
        try {
          const res = await page.goto(url, { waitUntil: "load", timeout: 120000 })
          await page.waitForTimeout(1500)
          if (open) {
            await page.getByRole("button", { name: open }).click()
            await page.waitForTimeout(600)
          }
          const noHScroll = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
          const small = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main button, main a[href], main textarea, [role=dialog] button, [role=dialog] textarea"
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
  let readme = `# R8 browser check (2026-11-01)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, the local worker and the stub model (no model cost). Local test users Asha (local owner, with her agent Lekha) and Ravi; ${SWITCHES.join(", ")} on for the flow and cleared at the end.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
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
