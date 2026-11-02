import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// R2 check (docs/rooms, the room core) on the isolated P-3 stack only:
// local Supabase, local Next.js on :6796, local test users. R2 has no room
// page (R3 adds it), so this checks two things:
// A. the room core's SQL path on real Postgres (PGlite in npm test), as two
//    signed-in local users the way withUser runs it: create, invite, join,
//    post, read, remove, and what a plain or removed member is refused;
// B. in a browser: the proxy rows (signed out → /login?next=… for
//    /rooms/join/<token>; /api/rooms/ → 401; signed in passes through), the
//    owner's Rooms settings group, and neighbouring screens unchanged.

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "rooms", "R2")
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

// A local test user, made without a password when missing
async function localUser(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const found = data.users.find((u) => u.email === email)
  if (found) return found.id
  const made = await admin.auth.admin.createUser({ email, email_confirm: true })
  if (made.error) throw made.error
  return made.data.user.id
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

/* ───────────── A. the room core on real Postgres ───────────── */

async function sqlPath(asha, ravi) {
  const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} })
  // As db/index.ts withUser: the person's claims, role authenticated, one transaction
  const as = (user, fn) =>
    db.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated" })}, true)`
      await tx`set local role authenticated`
      return fn(tx)
    })
  const refused = async (fn) => {
    try {
      await fn()
      return "allowed"
    } catch (e) {
      return `refused (${e.message.slice(0, 60)})`
    }
  }
  const checks = []
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail })

  const [room] = await as(
    asha,
    (tx) =>
      tx`insert into kriya.rooms (created_by, title) values (${asha}, 'R2 check room') returning id`
  )
  const roomId = room.id
  const [owner] = await as(
    asha,
    (tx) => tx`select role from kriya.room_members where room_id = ${roomId}`
  )
  check("create: creator becomes owner", owner?.role === "owner", owner?.role)

  const token = randomBytes(32).toString("base64url")
  const hash = createHash("sha256").update(token).digest("hex")
  await as(
    asha,
    (
      tx
    ) => tx`insert into kriya.room_invites (room_id, created_by, token_hash, max_uses, expires_at)
               values (${roomId}, ${asha}, ${hash}, 5, now() + make_interval(days => 7))`
  )
  const hashSelect = await refused(() =>
    as(
      asha,
      (tx) => tx`select token_hash from kriya.room_invites where room_id = ${roomId}`
    )
  )
  check("invite: token_hash not selectable", hashSelect.startsWith("refused"), hashSelect)

  const outsider = await as(
    ravi,
    (tx) =>
      tx`select count(*)::int as n from kriya.room_messages where room_id = ${roomId}`
  )
  check("non-member reads nothing", outsider[0].n === 0)

  const [joined] = await as(ravi, (tx) => tx`select kriya.join_room(${hash}, 25) as id`)
  check("join through the token", joined.id === roomId)

  for (const [user, body] of [
    [asha, "first"],
    [ravi, "second"],
    [asha, "third"],
  ])
    await as(
      user,
      (tx) => tx`insert into kriya.room_messages (room_id, author_kind, user_id, body)
                 values (${roomId}, 'human', ${user}, ${body})`
    )
  const seqs = await as(
    ravi,
    (tx) => tx`select seq from kriya.room_messages where room_id = ${roomId} order by seq`
  )
  check(
    "post: seq 1,2,3 from the database",
    seqs.map((r) => Number(r.seq)).join(",") === "1,2,3",
    seqs.map((r) => r.seq).join(",")
  )

  const forged = await refused(() =>
    as(
      ravi,
      (tx) => tx`insert into kriya.room_messages (room_id, author_kind, user_id, body)
                 values (${roomId}, 'human', ${asha}, 'forged')`
    )
  )
  check("post: can't post as someone else", forged.startsWith("refused"), forged)

  const memberInvite = await refused(() =>
    as(
      ravi,
      (
        tx
      ) => tx`insert into kriya.room_invites (room_id, created_by, token_hash, max_uses, expires_at)
                 values (${roomId}, ${ravi}, ${"0".repeat(64)}, 1, now() + interval '1 day')`
    )
  )
  check("invite: a plain member can't", memberInvite.startsWith("refused"), memberInvite)

  const ownerOut = await refused(() =>
    as(
      asha,
      (tx) =>
        tx`update kriya.room_members set left_at = now() where room_id = ${roomId} and user_id = ${asha}`
    )
  )
  check("the owner can't leave", ownerOut.startsWith("refused"), ownerOut)

  await as(
    asha,
    (tx) => tx`update kriya.room_members set left_at = now(), removed_by = ${asha}
               where room_id = ${roomId} and user_id = ${ravi}`
  )
  const afterRemoval = await as(
    ravi,
    (tx) =>
      tx`select count(*)::int as n from kriya.room_messages where room_id = ${roomId}`
  )
  check("remove: the removed member reads nothing", afterRemoval[0].n === 0)
  const rejoin = await refused(() =>
    as(ravi, (tx) => tx`select kriya.join_room(${hash}, 25)`)
  )
  check("remove: can't rejoin", rejoin.startsWith("refused"), rejoin)

  const [policy] = await db`select count(*)::int as n from pg_policies
    where schemaname = 'realtime' and tablename = 'messages' and policyname = 'kriya_room_members_receive'`
  check("realtime: guarded policy created on real Postgres", policy.n === 1)

  // A second invite whose token the browser part uses
  const browserToken = randomBytes(32).toString("base64url")
  await as(
    asha,
    (
      tx
    ) => tx`insert into kriya.room_invites (room_id, created_by, token_hash, max_uses, expires_at)
               values (${roomId}, ${asha}, ${createHash("sha256").update(browserToken).digest("hex")}, 1, now() + interval '1 day')`
  )
  await db.end()
  return { checks, browserToken }
}

/* ───────────────────────── B. browser ───────────────────────── */

async function shoot(browser, { id, url, cookies, anchor }, results, counter) {
  for (const vp of [
    { name: "360", width: 360, height: 800 },
    { name: "1280", width: 1280, height: 800 },
  ])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: theme,
      })
      if (cookies) await context.addCookies(cookies)
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
      try {
        const response = await page.goto(url, { waitUntil: "load", timeout: 120000 })
        await page.waitForTimeout(1000)
        const landed = new URL(page.url())
        let text = null
        if (anchor) {
          const node = page.getByText(anchor).first()
          await node.scrollIntoViewIfNeeded()
          text = (await node.locator("xpath=..").innerText()).replace(/\s+/g, " ").trim()
        }
        const noHScroll = await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
        const small = await page.evaluate(
          () =>
            [...document.querySelectorAll("button, a[href], input, select")].filter(
              (el) => {
                const r = el.getBoundingClientRect()
                return r.width > 0 && r.height > 0 && r.height < 44 && r.width < 44
              }
            ).length
        )
        const file = `${String(counter.n++).padStart(2, "0")}_${id}_${vp.name}_${theme}.png`
        await page.screenshot({ path: path.join(OUT_DIR, file) })
        results.push({
          file,
          screen: id,
          viewport: vp.name,
          theme,
          status: response?.status(),
          landed: landed.pathname + landed.search,
          consoleErrors,
          noHScroll,
          small,
          text,
        })
      } catch (error) {
        results.push({
          file: "—",
          screen: id,
          viewport: vp.name,
          theme,
          error: error.message,
        })
      } finally {
        await context.close()
      }
    }
}

async function run() {
  const asha = await localUser("asha@example.com")
  const ravi = await localUser("ravi.r2check@example.com")
  const { checks, browserToken } = await sqlPath(asha, ravi)

  const api = await fetch(`${APP_URL}/api/rooms/x/messages`)
  checks.push({
    name: "browserless: signed-out /api/rooms/ → 401 JSON",
    ok: api.status === 401,
    detail: `${api.status} ${await api.text()}`,
  })

  const ashaCookies = await cookiesFor("asha@example.com")
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const results = []
  const counter = { n: 1 }
  const joinPath = `/rooms/join/${browserToken}`
  await shoot(
    browser,
    { id: "signed-out-join", url: `${APP_URL}${joinPath}` },
    results,
    counter
  )
  await shoot(
    browser,
    { id: "signed-in-join", url: `${APP_URL}${joinPath}`, cookies: ashaCookies },
    results,
    counter
  )
  await shoot(
    browser,
    {
      id: "owner-config-rooms",
      url: `${APP_URL}/owner/config`,
      cookies: ashaCookies,
      anchor: "rooms.enabled",
    },
    results,
    counter
  )
  for (const [id, p] of [
    ["neighbour-home", "/home"],
    ["neighbour-account", "/account"],
  ])
    await shoot(
      browser,
      { id, url: `${APP_URL}${p}`, cookies: ashaCookies },
      results,
      counter
    )
  await browser.close()

  const signedOut = results.filter((r) => r.screen === "signed-out-join")
  checks.push({
    name: "browser: signed-out /rooms/join/<token> → /login?next=<that path>",
    ok: signedOut.every(
      (r) => r.landed === `/login?next=${encodeURIComponent(joinPath)}`
    ),
    detail: signedOut[0]?.landed?.replace(browserToken, "<token>"),
  })
  const signedIn = results.filter((r) => r.screen === "signed-in-join")
  checks.push({
    name: "browser: signed in, /rooms/join/<token> passes the proxy (no page until R3)",
    ok: signedIn.every((r) => r.landed === joinPath),
    detail: `status ${signedIn[0]?.status}`,
  })

  // The token was single-use and is printed nowhere
  for (const r of results)
    if (r.landed)
      r.landed = r.landed
        .replaceAll(browserToken, "<token>")
        .replaceAll(encodeURIComponent(browserToken), "<token>")
  fs.writeFileSync(
    path.join(OUT_DIR, "results.json"),
    JSON.stringify({ checks, results }, null, 2)
  )
  let readme = `# R2 browser check (2026-10-31)\n\nIsolated P-3 stack only: local Supabase (migrations applied locally, including 20270401000000_rooms.sql), local Next.js on :6796, local test users. R2 has no room page; R3 adds it. Full results in \`results.json\`.\n\n## Checks\n\n| Check | Result | Detail |\n| --- | --- | --- |\n`
  for (const c of checks)
    readme += `| ${c.name} | ${c.ok ? "pass" : "FAIL"} | ${String(c.detail ?? "").replace(/\|/g, "/")} |\n`
  readme += `\n## Screens\n\n| Screenshot | Screen | Viewport | Theme | Status | Landed | Console errors | No h-scroll | Targets < 44px | Text read |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`
  for (const r of results)
    readme += r.error
      ? `| — | ${r.screen} | ${r.viewport} | ${r.theme} | error: ${r.error} | | | | | |\n`
      : `| \`${r.file}\` | ${r.screen} | ${r.viewport} | ${r.theme} | ${r.status} | ${r.landed} | ${r.consoleErrors.length} | ${r.noHScroll ? "pass" : "FAIL"} | ${r.small} | ${r.text ?? ""} |\n`
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  for (const c of checks) console.log(`${c.ok ? "pass" : "FAIL"}  ${c.name}`)
  console.log(`${results.length} shots in ${OUT_DIR}`)
  if (checks.some((c) => !c.ok)) process.exit(1)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
