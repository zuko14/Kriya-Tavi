import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R7 browser check (docs/rooms/UX_SPEC.md §2, RD-13) on the isolated P-3
// stack only: local Supabase, local Next.js on :6796. Asha (local owner)
// and Ravi. The local stack has no web key, so no run can verify itself:
// one agent message with a proof card (one verified action) is inserted as
// local test data; everything else goes through the UI: set a goal, close
// one item with that verified action, confirm the other without proof, the
// goal done and said in the room, reopened, dropped; then the screens at
// 360 and 1280, light and dark.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R7")
const AGENT = "verify-r4-lekha"
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
      `rooms:goal:${asha}`,
      `rooms:goal:${ravi}`,
    ].map(limitKey)
  )}`

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const A = await context(browser, ashaCookies)
  const B = await context(browser, raviCookies)
  for (const key of SWITCHES) await setting(A, key, "on")

  /* ── a room with Ravi in it ── */
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "New room" }).click()
  await A.getByLabel("Name").fill("R7 check room")
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

  // Local test data: Lekha's reply with a card, one action verified
  await db`insert into kriya.agents (id, user_id, name, role, glyph)
           values (${AGENT}, ${asha}, 'Lekha', 'Researcher', ${AGENT})
           on conflict (id) do nothing`
  await db`insert into kriya.room_messages (room_id, author_kind, user_id, agent_id, body, parts)
           values (${roomId}, 'agent', ${asha}, ${AGENT}, 'I opened the draft pull request.',
                   ${db.json({
                     proof: {
                       kind: "proof",
                       done: [
                         {
                           title: "Opened a draft pull request",
                           status: "verified",
                           method: "api_readback",
                           evidence: [
                             {
                               kind: "url",
                               value: "https://github.com/example/launch/pull/42",
                             },
                           ],
                         },
                       ],
                       unconfirmed: 0,
                       checks: { supported: 0, unsupported: 0 },
                       verifiedBy: [],
                     },
                   })})`

  /* ── Asha sets a goal ── */
  await A.reload({ waitUntil: "load" })
  await A.getByRole("button", { name: "Goals" }).click()
  await snap(A, "goals-empty_1280_light")
  await A.getByLabel("Goal", { exact: true }).fill("Launch ready")
  await A.getByLabel("Items, one per line").fill("PR merged\nPrice sheet updated")
  await A.getByRole("button", { name: "Set goal" }).click()
  await A.getByText("Open · 0 of 2 closed").waitFor({ timeout: 15000 })
  check("RD-13: a member sets a goal with items", true)
  await A.keyboard.press("Escape")
  await listed(A)
    .getByText("Asha set a goal: “Launch ready”.")
    .waitFor({ timeout: 15000 })

  /* ── Ravi closes one with proof, confirms the other ── */
  await B.reload({ waitUntil: "load" })
  await B.getByRole("button", { name: "Goals" }).click()
  await B.getByLabel("Proof for “PR merged”").selectOption({ index: 1 })
  await snap(B, "goal-attach-proof_1280_light")
  await B.getByRole("button", { name: "Close with proof" }).first().click()
  await B.getByText("Opened a draft pull request · Lekha (agent of Asha)").waitFor({
    timeout: 15000,
  })
  check("RT-GOAL-01: an item closes with a verified action from a card in the room", true)
  await B.getByRole("button", { name: "Confirm, no proof" }).click()
  await B.getByText("Confirmed by Ravi, no proof").waitFor({ timeout: 15000 })
  await B.getByText("Done · 2 of 2 closed").waitFor({ timeout: 15000 })
  check("RT-GOAL-02: the goal is done once every item is closed", true)
  await snap(B, "goal-done_1280_light")
  await B.keyboard.press("Escape")
  await listed(A)
    .getByText(
      "Goal “Launch ready” is done: 1 of 2 items closed with proof, 1 confirmed without."
    )
    .waitFor({ timeout: 20000 })
  check("RT-GOAL-02: the room is told, with how many items had proof", true)
  const [goal] = await db`select status from kriya.room_goals where room_id = ${roomId}`
  check("RT-GOAL-02: the state in the database is code's", goal?.status === "done")

  /* ── reopened, then dropped ── */
  await A.reload({ waitUntil: "load" })
  await A.getByRole("button", { name: "Goals" }).click()
  await A.getByRole("button", { name: "Reopen" }).last().click()
  await A.getByText("Open · 1 of 2 closed").waitFor({ timeout: 15000 })
  check("RT-GOAL-02: reopening an item opens the goal again", true)
  await A.getByRole("button", { name: "Drop" }).click()
  await A.getByRole("alertdialog").getByRole("button", { name: "Drop goal" }).click()
  await A.getByText("Dropped · 1 of 2 closed").waitFor({ timeout: 15000 })
  check("RD-13: the owner drops the goal; it stays as dropped", true)
  await A.keyboard.press("Escape")

  // A second goal, left open for the screenshots
  await A.getByRole("button", { name: "Goals" }).click()
  await A.getByLabel("Goal", { exact: true }).fill("Landing page")
  await A.getByLabel("Items, one per line").fill("Copy reviewed\nPage live")
  await A.getByRole("button", { name: "Set goal" }).click()
  await A.getByText("Open · 0 of 2 closed").waitFor({ timeout: 15000 })
  await A.keyboard.press("Escape")

  /* ── screens at 360 and 1280, light and dark ── */
  const results = []
  for (const [id, cookies, open] of [
    ["room-with-goal-lines", raviCookies, null],
    ["goals-dialog", raviCookies, "Goals"],
    ["neighbour-room-info", ashaCookies, "Room info"],
  ])
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"]) {
        const page = await context(browser, cookies, { width, theme })
        try {
          const res = await page.goto(roomUrl, { waitUntil: "load", timeout: 120000 })
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
                "main button, main a[href], main textarea, main select, main input, [role=dialog] button, [role=dialog] select, [role=dialog] input, [role=dialog] textarea"
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
  let readme = `# R7 browser check (2026-11-01)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796. Local test users Asha (local owner) and Ravi; rooms.enabled on for the flow and cleared at the end. One agent message with a proof card (one verified action) was inserted as local test data, since the local stack has no web key for a run to verify itself; everything else went through the UI.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
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
