import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { chromium } from "playwright-core"

// SH7 browser check: the owner's "Self-hosted nodes" panel on /owner/cloud,
// on the isolated P-3 stack only (local Supabase, local Next.js on :6796,
// local test user Asha, the owner). First the page with the fabric unused
// (no panel), then with two nodes and leases seeded locally, then the /owner
// neighbour. The seeded rows are removed at the end. Same pattern as
// verify-c7-browser.mjs.

const SUPABASE_URL = "http://127.0.0.1:54321"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "cloud-execution", "SH7")
const WS = "5e7a0000-0000-4000-8000-0000000000a1"
const WS2 = "5e7a0000-0000-4000-8000-0000000000a2"

fs.mkdirSync(OUT_DIR, { recursive: true })

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !/@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL ?? "")
)
  throw new Error("Export .env.verify (local stack) and pass verify:guard first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

// A one-time magic link from the local stack's admin API, verified into
// session cookies: no password involved
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

async function unseed() {
  await sql`delete from kriya.exec_leases where workspace_id in (${WS}, ${WS2})`
  await sql`delete from kriya.workspaces where id in (${WS}, ${WS2})`
  await sql`delete from kriya.exec_nodes where id in ('sh7-node-a', 'sh7-node-b')`
}

async function seed(userId) {
  await sql`insert into kriya.exec_nodes (id, status, isolation, cpu_millis, mem_mb, disk_mb, disk_free_mb, healthy, psi_cpu, psi_mem, psi_io, reason, stats_at) values
    ('sh7-node-a', 'active', 'gvisor', 7000, 28672, 180000, 151000, true, 3.2, 0.4, 1.1, null, now() - interval '6 seconds'),
    ('sh7-node-b', 'draining', 'gvisor', 3500, 12288, 80000, 9000, false, 12.5, 18.0, 44.3, 'psi memory 18.0 over 10', now() - interval '4 minutes')`
  await sql`insert into kriya.workspaces (id, user_id, provider, image, size, status) values
    (${WS}, ${userId}, 'selfhosted', 'kriya-runner', '2c-4g', 'running'),
    (${WS2}, ${userId}, 'selfhosted', 'kriya-runner', '2c-4g', 'paused')`
  await sql`insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status, requested_at, granted_at) values
    (${userId}, ${WS}, 1, 'sh7-node-a', ${`sh-sh7-node-a-${WS}-1`}, 2000, 4096, 10240, 'running', now() - interval '20 minutes', now() - interval '20 minutes' + interval '3.4 seconds')`
  await sql`insert into kriya.exec_leases (user_id, workspace_id, generation, cpu_millis, mem_mb, disk_mb, status, requested_at, reason) values
    (${userId}, ${WS2}, 1, 2000, 4096, 10240, 'expired', now() - interval '30 minutes', 'start_timeout'),
    (${userId}, ${WS2}, 2, 2000, 4096, 10240, 'waiting', now() - interval '41 seconds', null)`
}

const scrollTo = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll("main *")].find(
      (e) => e.children.length === 0 && e.textContent?.includes(t)
    )
    el?.scrollIntoView({ block: "start" })
  }, text)

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
        await screen.before(page)
        await page.waitForTimeout(400)
        const panel = await page
          .getByRole("heading", { name: "Self-hosted nodes" })
          .count()
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
        await page.screenshot({
          path: path.join(OUT_DIR, file),
          fullPage: screen.fullPage,
        })
        results.push({
          file,
          screen: screen.id,
          viewport: vp.name,
          theme,
          panel: panel > 0,
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
  const [setting] =
    await sql`select value from kriya.platform_settings where key = 'cloud.provider'`
  if (
    setting?.value === "selfhosted" ||
    process.env.KRIYA_CLOUD_PROVIDER === "selfhosted"
  )
    throw new Error("cloud.provider is selfhosted locally; the unused case needs it off")
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const results = []
  const owner = `${APP_URL}/owner/cloud`
  try {
    await unseed()
    const [{ n }] = await sql`select count(*)::int as n from kriya.exec_nodes`
    if (n) throw new Error("Local exec_nodes rows exist; the unused case needs none")
    await shoot(
      browser,
      cookies,
      { id: "owner-cloud-unused", url: owner, before: async () => {}, fullPage: true },
      results
    )
    await seed(userId)
    await shoot(
      browser,
      cookies,
      {
        id: "owner-cloud-panel",
        url: owner,
        before: (p) => scrollTo(p, "Self-hosted nodes"),
      },
      results
    )
    await shoot(
      browser,
      cookies,
      {
        id: "owner-cloud-panel-table",
        url: owner,
        before: async (p) => {
          await scrollTo(p, "sh7-node-a")
          await p.evaluate(() => {
            const t = [...document.querySelectorAll("main table")].at(-1)?.parentElement
            if (t) t.scrollLeft = t.scrollWidth
          })
        },
      },
      results
    )
    await shoot(
      browser,
      cookies,
      { id: "neighbour-owner", url: `${APP_URL}/owner`, before: async () => {} },
      results
    )
  } finally {
    await unseed()
    await browser.close()
    await sql.end()
  }
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2))
  let readme = `# SH7 browser check: owner "Self-hosted nodes" panel (${new Date().toISOString().slice(0, 10)})\n\n`
  readme += `Isolated P-3 stack only: local Supabase, local Next.js dev server on :6796, local owner Asha (\`asha@example.com\`). \`owner-cloud-unused\`: no \`kriya.exec_nodes\` row and \`cloud.provider\` not selfhosted, so no panel (full page). Then two nodes and three leases seeded locally (removed afterwards): \`owner-cloud-panel\` (tiles), \`owner-cloud-panel-table\` (node table scrolled to its right edge). \`neighbour-owner\`: /owner. Full results in \`results.json\`.\n\n`
  readme += `| Screenshot | Screen | Viewport | Theme | Panel | Console errors | Failed requests | No h-scroll | Under 44 px |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`
  for (const r of results) {
    readme += r.error
      ? `| — | ${r.screen} | ${r.viewport} | ${r.theme} | | error: ${r.error} | | | |\n`
      : `| \`${r.file}\` | ${r.screen} | ${r.viewport} | ${r.theme} | ${r.panel ? "shown" : "hidden"} | ${r.consoleErrors.length} | ${r.failedRequests.length} | ${r.noHScroll ? "pass" : "FAIL"} | ${r.small.length} |\n`
  }
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  console.log(`${results.length} shots; README and results.json in ${OUT_DIR}`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
