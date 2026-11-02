import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R5 and R4 follow-up browser check (docs/rooms/UX_SPEC.md §2, §5) on the
// isolated P-3 stack only: local Supabase, local Next.js on :6796, the
// local worker and the stub model (no model cost). Asha (local owner) and
// Ravi, each with an agent. The owner turns rooms.enabled, rooms.agents and
// agents.inbox on in /owner/config; then: a reply with a proof card
// (collapsed, expanded), "Ask an agent to verify" answered by another
// owner's agent with the card in its request, a people mention reaching
// the notifier, the room request in the owner's thread; then the touched
// screens and neighbours at 360 and 1280, light and dark; then every switch
// cleared again.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R5")
const AGENT = "verify-r4-lekha"
const MIRA = "verify-r5-mira"
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
  // Earlier, interrupted runs may have left held replies: discard them, so
  // the Inbox shows only this run's (local test data)
  await db`update kriya.room_disclosures set status = 'discarded', answered_at = now()
           where owner_id = ${asha} and status = 'pending'`
  // and archive earlier runs' check rooms, which count toward
  // rooms.maxPerPerson while active
  await db`update kriya.rooms set status = 'archived'
           where status = 'active' and title in ('R4 check room', 'R5 check room')`
  // and reset the invite and join limits repeated runs use up (RD-18's
  // limits are tested in tests/rooms; keys are stored hashed)
  const limitKey = (key) =>
    createHash("sha256").update(key).digest("base64url").slice(0, 32)
  await db`delete from kriya.rate_limits where key in ${db(
    [`rooms:invite:${asha}`, "rooms:join:ip:unknown", "rooms:join:ip:127.0.0.1"].map(
      limitKey
    )
  )}`
  await db`insert into kriya.agents (id, user_id, name, role, glyph)
           values (${AGENT}, ${asha}, 'Lekha', 'Researcher', 'verify-r4')
           on conflict (id) do nothing`
  await db`insert into kriya.agents (id, user_id, name, role, glyph)
           values (${MIRA}, ${ravi}, 'Mira', 'Analyst', 'verify-r5')
           on conflict (id) do nothing`

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const A = await context(browser, ashaCookies)
  const B = await context(browser, raviCookies)
  for (const key of SWITCHES) await setting(A, key, "on")

  /* ── a room with both people and both agents ── */
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "New room" }).click()
  await A.getByLabel("Name").fill("R5 check room")
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
  for (const [page, name] of [
    [A, "Lekha"],
    [B, "Mira"],
  ]) {
    await page.reload({ waitUntil: "load" })
    await page.getByRole("button", { name: "Agents" }).click()
    await page.getByLabel("Agent to add").selectOption({ label: name })
    await page.getByRole("button", { name: "Add to room" }).click()
    await page.getByText("Your agent", { exact: false }).waitFor({ timeout: 15000 })
    await page.keyboard.press("Escape")
  }

  /* ── a reply with a proof card ── */
  const box = A.getByRole("textbox", { name: "Message" })
  await box.fill("@Lekha [verify:room-claim] compare the three vendors")
  await A.getByRole("button", { name: "Send" }).click()
  await listed(A)
    .getByText("Compared the three vendors", { exact: false })
    .waitFor({ timeout: 90000 })
  const summary = A.getByText("1 claim not verified", { exact: false })
  await summary.waitFor({ timeout: 10000 })
  check("RT-PRF-01: the reply carries a card counting the unverified claim", true)
  await snap(A, "card-collapsed_1280_light")
  await summary.click()
  await A.getByRole("button", { name: "Ask an agent to verify" }).waitFor({
    timeout: 5000,
  })
  await snap(A, "card-expanded_1280_light")

  /* ── Ravi asks his own agent to verify it ── */
  await B.reload({ waitUntil: "load" })
  await B.getByText("1 claim not verified", { exact: false }).click()
  await B.getByRole("button", { name: "Ask an agent to verify" }).click()
  check(
    "R5: the composer says the next message is about Lekha's card",
    (await B.getByText("About Lekha's card", { exact: false }).count()) === 1
  )
  const rbox = B.getByRole("textbox", { name: "Message" })
  await rbox.pressSequentially("Mi")
  const chip = B.getByRole("list", { name: "Agents to ask" }).getByRole("button", {
    name: /Mira/,
  })
  await chip.waitFor({ timeout: 5000 })
  await chip.click()
  await rbox.pressSequentially("please check this card")
  await snap(B, "verify-request_1280_light")
  await B.getByRole("button", { name: "Send" }).click()
  await listed(B)
    .getByText("about Lekha's card", { exact: false })
    .waitFor({ timeout: 15000 })
  await listed(B).getByText("Mira is working…").waitFor({ timeout: 15000 })
  await B.waitForFunction(
    () =>
      document.querySelectorAll("li").length > 0 &&
      document.body.innerText.includes("Mira · AI"),
    null,
    { timeout: 90000 }
  )
  const [request] = await db`select m.parts from kriya.messages m
    join kriya.room_agents a on a.bridge_thread_id = m.thread_id
    where a.room_id = ${roomId} and a.agent_id = ${MIRA} and m.role = 'user'
    order by m.created_at desc limit 1`
  check(
    "R5: Mira's request carries the card's claims (RD-09)",
    JSON.stringify(request?.parts ?? "").includes("Check these claims from Lekha's reply")
  )
  check(
    "R5: Mira's reply is Ravi's agent's, labelled as AI",
    (await B.getByText("Mira · AI · Ravi's agent").count()) > 0
  )
  await snap(B, "verify-reply_1280_light")

  /* ── a people mention reaches the notifier ── */
  await B.goto(`${APP_URL}/home`, { waitUntil: "load" })
  await B.waitForTimeout(2000)
  await box.fill("Ra")
  await box.fill("@Ra")
  const person = A.getByRole("list", { name: "People to mention" }).getByRole("button", {
    name: /Ravi/,
  })
  await person.waitFor({ timeout: 5000 })
  await snap(A, "people-picker_1280_light")
  await person.click()
  await box.pressSequentially("have a look at the card")
  await A.getByRole("button", { name: "Send" }).click()
  const toast = B.getByText("mentioned you", { exact: false })
  await toast.waitFor({ timeout: 20000 }).catch(() => {})
  check(
    "PX-03: Ravi, elsewhere in the app, gets an in-app card for the mention",
    (await toast.count()) > 0
  )
  await snap(B, "mention-toast_1280_light")

  /* ── the room request in the owner's thread ── */
  const [bridge] = await db`select bridge_thread_id as id from kriya.room_agents
    where room_id = ${roomId} and agent_id = ${AGENT}`
  await A.goto(`${APP_URL}/a/${AGENT}/${bridge.id}`, { waitUntil: "load" })
  await A.getByText("Room request", { exact: false }).first().waitFor({ timeout: 15000 })
  check(
    "R4 follow-up: the owner's thread shows the room request, the room quoted on a tap",
    (await A.getByText("compare the three vendors", { exact: false }).count()) > 0
  )
  await snap(A, "owner-thread-room-request_1280_light")

  /* ── screens at 360 and 1280, light and dark ── */
  const results = []
  const screens = [
    ["room-with-card", roomUrl, null, ashaCookies],
    ["room-card-expanded", roomUrl, "1 claim not verified", raviCookies],
    ["owner-thread", `${APP_URL}/a/${AGENT}/${bridge.id}`, null, ashaCookies],
    ["neighbour-inbox", `${APP_URL}/inbox`, null, ashaCookies],
    ["neighbour-home", `${APP_URL}/home`, null, raviCookies],
  ]
  for (const [id, url, open, cookies] of screens)
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"]) {
        const page = await context(browser, cookies, { width, theme })
        try {
          const res = await page.goto(url, { waitUntil: "load", timeout: 120000 })
          await page.waitForTimeout(1500)
          if (open) {
            await page.getByText(open, { exact: false }).first().click()
            await page.waitForTimeout(600)
          }
          const noHScroll = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
          const small = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main button, main a[href], main textarea, main select, main input, main summary"
              ),
            ]
              .filter((el) => {
                const r = el.getBoundingClientRect()
                if (el.matches("[data-slot=checkbox], input[aria-hidden=true]"))
                  return false
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

  /* ── switched off again ── */
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
  let readme = `# R5 browser check (2026-11-01)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, the local worker and the stub model (no model cost). Local test users Asha (local owner) and Ravi, each with an agent; ${SWITCHES.join(", ")} turned on in /owner/config for the flow and cleared again at the end. Full results in \`results.json\`.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
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
