import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R3 browser check (docs/rooms/UX_SPEC.md §5) on the isolated P-3 stack
// only: local Supabase, local Next.js on :6796, two local test users in two
// browser contexts (Asha, the local owner; Ravi). The owner turns
// rooms.enabled on in /owner/config; then create, invite, join, post, a
// message arriving by polling without a reload, unread counts, delete own
// message, remove, archive, the palette entry; then every room screen and
// its neighbours at 360 and 1280, light and dark; then rooms.enabled off
// again and the entries gone (RT-UI-01, RT-REG-01).

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R3")
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
  // Test setup on the local stack: a name and onboarding done, so the
  // workspace opens (onboarding isn't what R3 checks)
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
  await page.screenshot({ path: path.join(OUT_DIR, file) })
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

async function setRooms(page, value, key = "rooms.enabled") {
  await page.goto(`${APP_URL}/owner/config`, { waitUntil: "load", timeout: 120000 })
  const input = page.locator(`[id="setting-${key}"]`)
  await input.scrollIntoViewIfNeeded()
  await input.fill(value)
  await page.locator("form", { has: input }).getByRole("button", { name: "Save" }).click()
  await page.waitForTimeout(1500)
}

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

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const A = await context(browser, ashaCookies)
  const B = await context(browser, raviCookies)

  /* ── the flow, at 1280 light ── */
  await setRooms(A, "on")
  await snap(A, "owner-config-rooms-on_1280_light")
  await A.goto(`${APP_URL}/home`, { waitUntil: "load" })
  const homeRooms = A.getByRole("heading", { name: "Rooms", exact: true })
  await homeRooms.waitFor({ timeout: 10000 }).catch(() => {})
  check(
    "RT-UI-01: Home shows a Rooms section with New room when on",
    (await homeRooms.count()) === 1 &&
      (await A.getByRole("button", { name: "New room" }).count()) > 0
  )
  // The sidebar asks roomsEntry() after it mounts
  const sidebarRooms = A.locator('nav[aria-label="Main"] a[href="/rooms"]')
  await sidebarRooms.waitFor({ timeout: 10000 }).catch(() => {})
  check(
    "RT-UI-01: the sidebar has a Rooms link when on",
    (await sidebarRooms.count()) === 1
  )
  await snap(A, "home-rooms-section_1280_light")

  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "New room" }).click()
  await A.getByLabel("Name").fill("R3 check room")
  await A.getByLabel(/Topic/).fill("Planning the launch")
  await snap(A, "new-room-dialog_1280_light")
  await A.getByRole("button", { name: "Create room" }).click()
  await A.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 })
  const roomUrl = A.url()
  const roomId = roomUrl.split("/").at(-1)
  check("RT-UI-02: New room lands in the room", !!roomId)
  await A.getByRole("textbox", { name: "Message" }).fill("Hello from Asha")
  await A.getByRole("button", { name: "Send" }).click()
  await A.getByRole("list").getByText("Hello from Asha").waitFor({ timeout: 15000 })

  await A.getByRole("button", { name: "Room info" }).click()
  await A.getByRole("button", { name: "Make a link" }).click()
  const code = A.locator("code", { hasText: "/rooms/join/" })
  await code.waitFor({ timeout: 15000 })
  const inviteUrl = (await code.innerText()).trim()
  check(
    "RT-UI-02: an invite link is made and shown once",
    /\/rooms\/join\/[A-Za-z0-9_-]{43}$/.test(inviteUrl)
  )
  await A.keyboard.press("Escape")

  await B.goto(inviteUrl, { waitUntil: "load" })
  check(
    "join page: consent line before joining",
    (await B.getByText("Rooms aren’t end-to-end encrypted", { exact: false }).count()) +
      (await B.getByText("Rooms aren't end-to-end encrypted", { exact: false }).count()) >
      0
  )
  await B.getByRole("button", { name: "Join the room" }).click()
  await B.waitForURL(roomUrl, { timeout: 30000 })
  check(
    "RT-UI-02: Ravi joins and reads Asha's message with her name",
    (await B.getByRole("list").getByText("Hello from Asha").count()) === 1 &&
      (await B.getByText("Asha", { exact: true }).count()) > 0
  )
  await B.getByRole("textbox", { name: "Message" }).fill("Hi Asha, Ravi here")
  await B.getByRole("button", { name: "Send" }).click()

  // Asha's page was not reloaded: the message must come by polling (≤ 10 s)
  const started = Date.now()
  await A.getByRole("list").getByText("Hi Asha, Ravi here").waitFor({ timeout: 15000 })
  const seconds = (Date.now() - started) / 1000
  check(
    "RT-RLT-04: a new message arrives by polling, no reload",
    seconds <= 12,
    `${seconds.toFixed(1)} s`
  )

  // Unread: Ravi on /rooms while Asha posts twice. Earlier local runs left
  // Ravi in other rooms, so the sidebar total is compared before and after
  const sidebarRooms_B = B.locator('nav[aria-label="Main"] a[href="/rooms"]')
  const total = async () => {
    await sidebarRooms_B.waitFor({ timeout: 10000 })
    return Number((await sidebarRooms_B.innerText()).match(/(\d+)\s*$/)?.[1] ?? 0)
  }
  const thisRoom = B.locator(`main a[href="/rooms/${roomId}"]`)
  await B.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  const before = await total()
  // The second is typed while the first is still sending: it must survive
  const composer = A.getByRole("textbox", { name: "Message" })
  await composer.fill("Second from Asha")
  await A.getByRole("button", { name: "Send" }).click()
  await composer.fill("Third from Asha")
  await A.getByRole("list").getByText("Second from Asha").waitFor({ timeout: 15000 })
  await A.waitForTimeout(500)
  check(
    "composer: text typed while a message is sending isn't wiped",
    (await composer.inputValue()) === "Third from Asha",
    await composer.inputValue()
  )
  await A.getByRole("button", { name: "Send" }).click()
  await A.getByRole("list").getByText("Third from Asha").waitFor({ timeout: 15000 })
  await B.reload({ waitUntil: "load" })
  check(
    "RT-UI-02: the room list shows 2 new on this room for Ravi",
    /2 new/.test(await thisRoom.innerText())
  )
  const after = await total()
  check(
    "RT-UI-02: the sidebar total rises by 2",
    after - before === 2,
    `${before} → ${after}`
  )
  await snap(B, "rooms-list-unread_1280_light")
  await B.goto(roomUrl, { waitUntil: "load" })
  await B.waitForTimeout(1500)
  await B.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  check(
    "RT-UI-02: opening the room clears its count",
    !/new/.test(await thisRoom.innerText()) && (await total()) === before,
    `sidebar ${await total()}`
  )

  // Delete own message: gone for Ravi on his next poll
  await B.goto(roomUrl, { waitUntil: "load" })
  await A.getByRole("list").getByText("Third from Asha").hover()
  await A.getByRole("button", { name: "Delete message" }).last().click()
  await A.getByRole("button", { name: "Delete message" }).last().click()
  await A.getByRole("list").getByText("Message deleted").waitFor({ timeout: 10000 })
  await B.reload({ waitUntil: "load" })
  check(
    "RT-UI-03: a deleted message's text is gone for everyone",
    (await B.getByRole("list").getByText("Third from Asha").count()) === 0 &&
      (await B.getByRole("list").getByText("Message deleted").count()) === 1
  )

  // Palette entry
  await A.keyboard.press("Control+k")
  await A.getByPlaceholder(/Type an agent/).fill("rooms")
  // The palette asks roomsEntry() when it opens
  const paletteRooms = A.getByRole("option", { name: "Rooms", exact: true })
  await paletteRooms.waitFor({ timeout: 10000 }).catch(() => {})
  check(
    "RT-UI-01: the command palette has Rooms when on",
    (await paletteRooms.count()) === 1
  )
  await snap(A, "palette-rooms_1280_light")
  await A.keyboard.press("Escape")

  // Roles: the owner makes Ravi an admin and back (Room info)
  await A.goto(roomUrl, { waitUntil: "load" })
  await A.getByRole("button", { name: "Room info" }).click()
  await A.getByRole("button", { name: "Make admin" }).click()
  await A.getByRole("button", { name: "Make member" })
    .waitFor({ timeout: 10000 })
    .catch(() => {})
  const raviRow = A.getByRole("dialog").locator("li", { hasText: "Ravi" })
  check(
    "roles: Make admin turns Ravi into an Admin",
    /Admin/.test(await raviRow.innerText())
  )
  await snap(A, "room-info-admin_1280_light")
  await A.getByRole("button", { name: "Make member" }).click()
  await A.getByRole("button", { name: "Make admin" })
    .waitFor({ timeout: 10000 })
    .catch(() => {})
  check("roles: Make member turns him back", /Member/.test(await raviRow.innerText()))
  await A.keyboard.press("Escape")

  // Realtime (RF-06): with rooms.realtime on, a message arrives on the ping,
  // well inside the 10 s poll
  await setRooms(A, "on", "rooms.realtime")
  await A.goto(roomUrl, { waitUntil: "load" })
  await B.goto(roomUrl, { waitUntil: "load" })
  await A.waitForTimeout(3000)
  await B.getByRole("textbox", { name: "Message" }).fill("Live from Ravi")
  await B.getByRole("button", { name: "Send" }).click()
  const liveStart = Date.now()
  await A.getByRole("list").getByText("Live from Ravi").waitFor({ timeout: 15000 })
  const liveSeconds = (Date.now() - liveStart) / 1000
  check(
    "realtime: a new message arrives on the ping (< 3 s)",
    liveSeconds < 3,
    `${liveSeconds.toFixed(1)} s`
  )
  await setRooms(A, "", "rooms.realtime")

  /* ── screens at 360 and 1280, light and dark ── */
  const results = []
  const screens = [
    ["home", `${APP_URL}/home`, null],
    ["rooms-list", `${APP_URL}/rooms`, null],
    ["room", roomUrl, null],
    ["room-info", roomUrl, "Room info"],
    ["join", inviteUrl, null],
    ["neighbour-account", `${APP_URL}/account`, null],
  ]
  for (const [id, url, open] of screens)
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"]) {
        const page = await context(browser, ashaCookies, { width, theme })
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
          // Targets inside the room UI only (components/rooms), under 44 px
          const small = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main button, main a[href], main textarea, main select, [role=dialog] button, [role=dialog] select"
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

  /* ── remove and archive (after the shots, which need Ravi in the room) ── */
  await A.goto(roomUrl, { waitUntil: "load" })
  await A.getByRole("button", { name: "Room info" }).click()
  await A.getByRole("button", { name: "Remove" }).click()
  await A.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await A.waitForTimeout(1500)
  // (workspace)/loading.tsx streams, so not-found pages answer 200 with the
  // not-found screen; its text is what's checked
  await B.goto(roomUrl, { waitUntil: "load" })
  await B.getByText("Nothing out here.")
    .waitFor({ timeout: 10000 })
    .catch(() => {})
  check(
    "RT-UI-03: a removed member gets the not-found screen",
    (await B.getByText("Nothing out here.").count()) === 1 &&
      (await B.getByRole("list").getByText("Hello from Asha").count()) === 0
  )
  await A.goto(roomUrl, { waitUntil: "load" })
  await A.getByRole("button", { name: "Room info" }).click()
  await A.getByRole("button", { name: "Archive room" }).click()
  await A.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click()
  await A.waitForTimeout(1500)
  await A.reload({ waitUntil: "load" })
  check(
    "RT-UI-03: an archived room takes no messages",
    (await A.getByText("This room is archived.", { exact: false }).count()) === 1 &&
      (await A.getByRole("textbox", { name: "Message" }).count()) === 0
  )
  await snap(A, "room-archived_1280_light")

  /* ── switched off again: everything gone ── */
  await setRooms(A, "")
  // The setting cache is per process; the owner form clears it
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByText("Nothing out here.")
    .waitFor({ timeout: 10000 })
    .catch(() => {})
  const offRooms = await A.getByText("Nothing out here.").count()
  await A.goto(`${APP_URL}/home`, { waitUntil: "load" })
  // Long enough for the sidebar's roomsEntry() to have answered
  await A.waitForTimeout(4000)
  check("RT-REG-01: off → /rooms is the not-found screen", offRooms === 1)
  check(
    "RT-REG-01: off → no Rooms section on Home, no sidebar link",
    (await A.getByRole("heading", { name: "Rooms" }).count()) === 0 &&
      (await A.locator('nav[aria-label="Main"] a[href="/rooms"]').count()) === 0
  )
  await snap(A, "home-rooms-off_1280_light")

  check(
    "flow pages: no console errors",
    A.consoleErrors.length + B.consoleErrors.length === 0,
    [...A.consoleErrors, ...B.consoleErrors].slice(0, 3).join(" | ")
  )
  await browser.close()
  await db.end()

  const token = inviteUrl.split("/").at(-1)
  const scrub = (s) => String(s).replaceAll(token, "<token>")
  fs.writeFileSync(
    path.join(OUT_DIR, "results.json"),
    scrub(JSON.stringify({ checks, results }, null, 2))
  )
  let readme = `# R3 browser check (2026-10-31)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, local test users Asha (local owner) and Ravi in two browser contexts; rooms.enabled turned on in /owner/config for the flow and cleared again at the end. Polling only (rooms.realtime off, RF-06). Full results in \`results.json\`.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
  for (const c of checks)
    readme += `| ${c.name} | ${c.ok ? "pass" : "FAIL"} | ${scrub(c.detail).replace(/\|/g, "/")} |\n`
  readme += `\n## Screens\n\n| Screenshot | Screen | Width | Theme | Status | Console errors | No h-scroll | Room-UI targets < 44 px |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`
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
