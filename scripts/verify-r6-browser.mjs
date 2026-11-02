import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R6 browser check (docs/rooms/UX_SPEC.md §2, RD-12) on the isolated P-3
// stack only: local Supabase, local Next.js on :6796, the stub model.
// Two modes, because a stubbed agent works for about a second:
//   node scripts/verify-r6-browser.mjs stop    (worker NOT running): a
//     request stays queued, "Stop agents" shows, Ravi (a plain member)
//     presses it, the room says so and shows the pause;
//   node scripts/verify-r6-browser.mjs chain   (worker running): Lekha's
//     reply names Mira, the conductor gives Mira her turn.
// Each mode takes its screens at 360 and 1280, light and dark.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const MODE = process.argv[2] === "chain" ? "chain" : "stop"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R6", MODE)
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
  await db`update kriya.room_disclosures set status = 'discarded', answered_at = now()
           where owner_id = ${asha} and status = 'pending'`
  await db`update kriya.rooms set status = 'archived'
           where status = 'active' and title in ('R4 check room', 'R5 check room', 'R6 check room')`
  const limitKey = (key) =>
    createHash("sha256").update(key).digest("base64url").slice(0, 32)
  await db`delete from kriya.rate_limits where key in ${db(
    [
      `rooms:invite:${asha}`,
      "rooms:join:ip:unknown",
      "rooms:join:ip:127.0.0.1",
      `rooms:stop:${ravi}`,
    ].map(limitKey)
  )}`
  for (const [id, user, name] of [
    [AGENT, asha, "Lekha"],
    [MIRA, ravi, "Mira"],
  ])
    await db`insert into kriya.agents (id, user_id, name, role, glyph)
             values (${id}, ${user}, ${name}, 'Researcher', ${id})
             on conflict (id) do nothing`

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const A = await context(browser, ashaCookies)
  const B = await context(browser, raviCookies)
  for (const key of SWITCHES) await setting(A, key, "on")

  /* ── a room with both people and both agents; Mira takes requests from members ── */
  await A.goto(`${APP_URL}/rooms`, { waitUntil: "load" })
  await A.getByRole("button", { name: "New room" }).click()
  await A.getByLabel("Name").fill("R6 check room")
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
    if (name === "Mira") {
      await page.getByLabel("Who can ask it").selectOption("members")
      await page.getByLabel("Daily limit in rupees").fill("20")
      await page.getByRole("button", { name: "Save" }).click()
      await page.waitForTimeout(1500)
    }
    await page.keyboard.press("Escape")
  }

  const box = A.getByRole("textbox", { name: "Message" })
  if (MODE === "stop") {
    /* ── no worker: the request stays queued, Stop shows ── */
    await box.fill("@Lekha [verify:room-chain] compare the vendors")
    await A.getByRole("button", { name: "Send" }).click()
    await listed(A).getByText("Lekha is working…").waitFor({ timeout: 15000 })
    await B.reload({ waitUntil: "load" })
    const stopButton = B.getByRole("button", { name: "Stop agents" })
    await stopButton.waitFor({ timeout: 15000 })
    check(
      "RD-12: while an agent works, any member sees Stop agents",
      (await B.getByText("Lekha working…").count()) > 0
    )
    await snap(B, "stop-visible_1280_light")
    await stopButton.click()
    await listed(B)
      .getByText("Ravi stopped the agents for 10 minutes.")
      .waitFor({ timeout: 15000 })
    await B.getByText("Agents are paused until", { exact: false }).waitFor({
      timeout: 10000,
    })
    check(
      "RT-CND-04: Stop pauses the room's agents for 10 minutes, said in the room",
      (await B.getByRole("button", { name: "Stop agents" }).count()) === 0
    )
    const [room] =
      await db`select round(extract(epoch from agents_paused_until - now()) / 60)::int as minutes from kriya.rooms where id = ${roomId}`
    check(
      "RT-CND-04: the pause is ten minutes",
      room.minutes === 10,
      `${room.minutes} min`
    )
    // Asha's queued task is hers: Ravi's Stop left it alone
    const [task] = await db`select status from kriya.tasks where user_id = ${asha}
      and input ->> 'roomId' = ${roomId}`
    check("RT-CND-04: another owner's task isn't touched", task?.status === "queued")
    await snap(B, "stopped_1280_light")
    // Mira is idle (Lekha is still busy, which check_room_invocation says first)
    await box.fill("@Mira are you there?")
    await A.getByRole("button", { name: "Send" }).click()
    await listed(A)
      .getByText("Agents are paused in this room for now.")
      .waitFor({ timeout: 15000 })
    check("RT-CND-04: a request while paused gets a plain line", true)
    // Leave nothing queued behind for the next run's worker
    await db`update kriya.tasks set status = 'canceled', finished_at = now()
             where user_id = ${asha} and input ->> 'roomId' = ${roomId} and status = 'queued'`
  } else {
    /* ── worker running: Lekha's reply hands the question to Mira ── */
    await box.fill("@Lekha [verify:room-chain] compare the vendors")
    await A.getByRole("button", { name: "Send" }).click()
    await listed(A)
      .getByText("@Mira can you confirm the price of vendor A?")
      .first()
      .waitFor({ timeout: 90000 })
    await listed(A).getByText("Mira is working…").waitFor({ timeout: 30000 })
    await A.waitForFunction(
      () => document.body.innerText.includes("Mira · AI · Ravi's agent"),
      null,
      { timeout: 90000 }
    )
    const chain = await db`select agent_id, chain_depth, requested_by, status
      from kriya.room_invocations where room_id = ${roomId} order by created_at`
    check(
      "RT-CND-01/03: Mira's turn is a follow-on of Asha's message (depth 1, asked for Asha)",
      chain.length === 2 &&
        chain[1].agent_id === MIRA &&
        chain[1].chain_depth === 1 &&
        chain[1].requested_by === asha,
      JSON.stringify(chain.map((c) => [c.agent_id, c.chain_depth, c.status]))
    )
    const [request] = await db`select m.parts from kriya.messages m
      join kriya.room_agents a on a.bridge_thread_id = m.thread_id
      where a.room_id = ${roomId} and a.agent_id = ${MIRA} and m.role = 'user'
      order by m.created_at desc limit 1`
    check(
      "CONVERSATION_PROTOCOL §7: Mira's request names Lekha as the asker",
      JSON.stringify(request?.parts ?? "").includes("Requested by Lekha, Asha's agent")
    )
    await snap(A, "chain_1280_light")
  }

  /* ── screens at 360 and 1280, light and dark ── */
  const results = []
  for (const [id, cookies] of [
    ["room-asha", ashaCookies],
    ["room-ravi", raviCookies],
  ])
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"]) {
        const page = await context(browser, cookies, { width, theme })
        try {
          const res = await page.goto(roomUrl, { waitUntil: "load", timeout: 120000 })
          await page.waitForTimeout(1500)
          const noHScroll = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
          const small = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main button, main a[href], main textarea, main summary"
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

  /* ── clean up ── */
  await db`update kriya.rooms set agents_paused_until = null where id = ${roomId}`
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
  let readme = `# R6 browser check, mode "${MODE}" (2026-11-01)\n\nIsolated P-3 stack only: local Supabase, local Next.js on :6796, the stub model${MODE === "chain" ? " and the local worker" : "; the worker NOT running, so the request stays queued"}. Local test users Asha (local owner) and Ravi, each with an agent; ${SWITCHES.join(", ")} on for the flow and cleared at the end.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
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
