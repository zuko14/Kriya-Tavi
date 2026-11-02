import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R4 browser check (docs/rooms/UX_SPEC.md §2, §3, §5) on the isolated P-3
// stack only: local Supabase, local Next.js on :6796, the local worker and
// the stub model (no model cost). Asha (local owner) and Ravi in two browser
// contexts. The owner turns rooms.enabled, rooms.agents, agents.inbox and
// agents.ledger on in /owner/config; then: add an agent, the @ picker, a
// mention answered by the worker, another member refused (owner_only), a
// reply after a private read held for Share in room, Share from the Inbox;
// then the touched screens and their neighbours at 360 and 1280, light and
// dark; then every switch cleared again and the agents gone (RT-REG-01).

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R4")
const AGENT = "verify-r4-lekha"
const SWITCHES = ["rooms.enabled", "rooms.agents", "agents.inbox", "agents.ledger"]
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
  await localUser("ravi.r2check@example.com", "Ravi")
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
  // Local test data: Asha's agent, and the ledger on her plan (ledger_list
  // is the private read that the disclosure path needs without Google)
  await db`insert into kriya.agents (id, user_id, name, role, glyph)
           values (${AGENT}, ${asha}, 'Lekha', 'Researcher', 'verify-r4')
           on conflict (id) do nothing`
  await db`update kriya.plans set ledger_enabled = true
           where id = (select coalesce(s.plan_id, 'free') from kriya.subscriptions s where s.user_id = ${asha} limit 1)
              or id = 'free'`

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const A = await context(browser, ashaCookies)
  const B = await context(browser, raviCookies)

  for (const key of SWITCHES) await setting(A, key, "on")
  await snap(A, "owner-config-switches-on_1280_light")

  /* ── a room with Ravi in it ── */
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "New room" }).click()
  await A.getByLabel("Name").fill("R4 check room")
  await A.getByRole("button", { name: "Create room" }).click()
  await A.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 })
  const roomUrl = A.url()
  await A.getByRole("button", { name: "Room info" }).click()
  await A.getByRole("button", { name: "Make a link" }).click()
  const code = A.locator("code", { hasText: "/rooms/join/" })
  await code.waitFor({ timeout: 15000 })
  const inviteUrl = (await code.innerText()).trim()
  await A.keyboard.press("Escape")
  await B.goto(inviteUrl, { waitUntil: "load" })
  await B.getByRole("button", { name: "Join the room" }).click()
  await B.waitForURL(roomUrl, { timeout: 30000 })

  /* ── add an agent ── */
  await A.reload({ waitUntil: "load" })
  await A.getByRole("button", { name: "Agents" }).click()
  await snap(A, "agents-sheet-empty_1280_light")
  await A.getByRole("button", { name: "Add to room" }).click()
  await A.getByText("Your agent", { exact: false }).waitFor({ timeout: 15000 })
  await snap(A, "agents-sheet-added_1280_light")
  await A.keyboard.press("Escape")
  await listed(A).getByText("Asha added Lekha to the room.").waitFor({ timeout: 15000 })
  check("R4: adding an agent posts a system line", true)

  /* ── the @ picker and a mention the worker answers ── */
  const box = A.getByRole("textbox", { name: "Message" })
  await box.fill("@Le")
  const chip = A.getByRole("list", { name: "Agents to ask" }).getByRole("button", {
    name: /Lekha/,
  })
  await chip.waitFor({ timeout: 5000 })
  await snap(A, "mention-picker_1280_light")
  await chip.click()
  check("R4: the picker writes the mention", (await box.inputValue()) === "@Lekha ")
  await box.pressSequentially("[verify:room-reply] compare three vendors")
  await A.getByRole("button", { name: "Send" }).click()
  await listed(A).getByText("Lekha is working…").waitFor({ timeout: 15000 })
  const started = Date.now()
  await listed(A)
    .getByText("Compared three vendors", { exact: false })
    .waitFor({ timeout: 90000 })
  check(
    "RT-INV-01: the mention runs as Asha's task and the reply reaches the room",
    true,
    `${((Date.now() - started) / 1000).toFixed(1)} s after "working"`
  )
  check(
    "R4: the reply is labelled as AI and as Asha's agent",
    (await A.getByText("Lekha · AI · Asha's agent").count()) > 0
  )
  await snap(A, "agent-reply_1280_light")
  await listed(B)
    .getByText("Compared three vendors", { exact: false })
    .waitFor({ timeout: 20000 })
  check(
    "RD-17: Ravi sees the reply and no cost line",
    (await B.getByText("Cost ₹", { exact: false }).count()) === 0
  )

  /* ── another member, owner_only ── */
  await B.getByRole("textbox", { name: "Message" }).fill("@Le")
  const greyed = B.getByRole("list", { name: "Agents to ask" }).getByRole("button", {
    name: /Lekha/,
  })
  await greyed.waitFor({ timeout: 5000 })
  check(
    "RT-INV-02: Ravi's picker shows Lekha greyed, answering only to Asha",
    (await greyed.isDisabled()) &&
      (await greyed.innerText()).includes("answers only to Asha")
  )
  await snap(B, "mention-picker-other_1280_light")
  await B.getByRole("textbox", { name: "Message" }).fill("@Lekha read Asha's accounts")
  await B.getByRole("button", { name: "Send" }).click()
  await listed(B).getByText("Lekha answers only to Asha.").waitFor({ timeout: 20000 })
  check("RT-INV-02: Ravi's typed mention is refused with a plain line", true)

  /* ── a private read: held for Share in room ── */
  // The stub follows the first [verify:…] marker in the bridge message, and
  // the room is quoted before the request: delete the earlier request
  // (deleted messages are never quoted), which also checks delete with agents
  await A.getByRole("button", { name: "Delete message" }).first().click()
  await A.getByRole("alertdialog").getByRole("button", { name: "Delete message" }).click()
  await listed(A).getByText("Message deleted").first().waitFor({ timeout: 10000 })
  await box.fill("@Lekha [verify:room-private] anything overdue?")
  await A.getByRole("button", { name: "Send" }).click()
  await listed(A)
    .getByText("Lekha replied; waiting for Asha to share it.")
    .waitFor({ timeout: 90000 })
  check(
    "RT-AGT-03: a reply after a private read waits; nothing private is posted",
    (await listed(B).getByText("nothing is overdue", { exact: false }).count()) === 0
  )
  await A.goto(`${APP_URL}/inbox`, { waitUntil: "load" })
  const card = A.getByRole("heading", { name: /Share Lekha's reply in/ })
  await card.waitFor({ timeout: 15000 })
  check(
    "UX §3: the Inbox shows the exact text with Share in room / Discard",
    (await A.getByText("From your accounts: nothing is overdue this month.").count()) ===
      1 &&
      (await A.getByRole("button", { name: "Share in room" }).count()) === 1 &&
      (await A.getByRole("button", { name: "Discard" }).count()) === 1
  )
  await snap(A, "inbox-share-in-room_1280_light")
  await A.getByRole("button", { name: "Share in room" }).click()
  await A.waitForTimeout(1500)
  await B.reload({ waitUntil: "load" })
  await listed(B)
    .getByText("From your accounts: nothing is overdue this month.")
    .waitFor({ timeout: 20000 })
  check(
    "RT-AGT-04: Share posts the stored text; the waiting line is replaced",
    (await listed(B).getByText("waiting for Asha to share it").count()) === 0
  )
  await snap(B, "shared-reply_1280_light")

  // One more held reply, left pending for the Inbox screenshots, discarded after
  await A.goto(roomUrl, { waitUntil: "load" })
  await A.getByRole("textbox", { name: "Message" }).fill(
    "@Lekha [verify:room-private] and next month?"
  )
  await A.getByRole("button", { name: "Send" }).click()
  await listed(A)
    .getByText("Lekha replied; waiting for Asha to share it.")
    .waitFor({ timeout: 90000 })

  /* ── screens at 360 and 1280, light and dark ── */
  const results = []
  const screens = [
    ["room-with-agents", roomUrl, null, ashaCookies],
    ["agents-sheet", roomUrl, "Agents", ashaCookies],
    ["room-other-member", roomUrl, null, raviCookies],
    ["inbox", `${APP_URL}/inbox`, null, ashaCookies],
    ["neighbour-rooms-list", `${APP_URL}/rooms`, null, ashaCookies],
    ["neighbour-room-info", roomUrl, "Room info", ashaCookies],
  ]
  for (const [id, url, open, cookies] of screens)
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"]) {
        const page = await context(browser, cookies, { width, theme })
        try {
          const res = await page.goto(url, { waitUntil: "load", timeout: 120000 })
          await page.waitForTimeout(1200)
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
                "main button, main a[href], main textarea, main select, main input, [role=dialog] button, [role=dialog] select, [role=dialog] input"
              ),
            ]
              .filter((el) => {
                const r = el.getBoundingClientRect()
                if (el.matches("[data-slot=checkbox]")) return false
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

  // Discard the pending one: nothing posted
  const before =
    await db`select count(*)::int as n from kriya.room_messages where room_id = ${roomUrl.split("/").at(-1)}`
  await A.goto(`${APP_URL}/inbox`, { waitUntil: "load" })
  await A.getByRole("button", { name: "Discard" }).click()
  await A.waitForTimeout(1500)
  const after =
    await db`select count(*)::int as n from kriya.room_messages where room_id = ${roomUrl.split("/").at(-1)}`
  check("RT-AGT-04: Discard posts nothing", before[0].n === after[0].n)

  /* ── switched off again ── */
  // Ravi's open room keeps polling; once rooms.enabled is off its catch-up
  // route answers 404 (RT-REG-01), which isn't a flow error: count his
  // console now and close the page first
  const raviErrors = [...B.consoleErrors]
  await B.context().close()
  await setting(A, "rooms.agents", "")
  await A.goto(roomUrl, { waitUntil: "load" })
  await A.waitForTimeout(1000)
  check(
    "RT-REG-01: rooms.agents off → no Agents button, the room still works for people",
    (await A.getByRole("button", { name: "Agents" }).count()) === 0 &&
      (await A.getByRole("textbox", { name: "Message" }).count()) === 1
  )
  await snap(A, "room-agents-off_1280_light")
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
  let readme = `# R4 browser check (2026-11-01)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, the local worker and the stub model (no model cost; charges unpriced). Local test users Asha (local owner) and Ravi in two browser contexts; ${SWITCHES.join(", ")} turned on in /owner/config for the flow and cleared again at the end. Full results in \`results.json\`.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
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
