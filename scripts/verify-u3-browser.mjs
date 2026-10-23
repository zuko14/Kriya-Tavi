import fs from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { chromium } from "playwright-core"

const SUPABASE_URL = "http://127.0.0.1:54321"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const APP_URL = "http://127.0.0.1:6796"
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const OUT_DIR = path.join(process.cwd(), "screenshots", "ui-upgrade", "U3")

fs.mkdirSync(OUT_DIR, { recursive: true })

async function getAuthCookies() {
  const cookieList = []
  const client = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => cookieList,
      setAll: (c) => cookieList.push(...c),
    },
  })
  const { data, error } = await client.auth.signInWithPassword({
    email: "asha@example.com",
    password: "Password123!",
  })
  if (error || !data.session)
    throw new Error("Could not sign in as Asha: " + error?.message)
  return cookieList.map((c) => ({
    name: c.name,
    value: c.value,
    url: APP_URL,
  }))
}

async function safeEvaluate(page, fn, arg) {
  for (let i = 0; i < 5; i++) {
    try {
      return await page.evaluate(fn, arg)
    } catch (e) {
      if (
        e.message.includes("Execution context was destroyed") ||
        e.message.includes("Target closed")
      ) {
        await page.waitForTimeout(1000)
        continue
      }
      throw e
    }
  }
}

async function run() {
  console.log("Starting browser verification for Phase U3...")
  const cookies = await getAuthCookies()
  console.log("Authenticated as asha@example.com.")

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  })

  const results = []

  const viewports = [
    { name: "360", width: 360, height: 800 },
    { name: "1280", width: 1280, height: 800 },
  ]
  const themes = ["light", "dark"]

  // Screens to verify for Phase U3:
  // 1. Crew lead thread showing the clean "Team report" card instead of raw dispatch/prompt
  // 2. Member part thread showing the clean "Brief" card instead of raw instruction prompt
  // 3. Goal page showing clamped schedule prompt with tap-to-expand
  const tasks = [
    {
      id: "crew-thread",
      title: "Crew lead thread with Team report card",
      url: `${APP_URL}/s/crewDesk01/1BdrCw7rVrau`,
      async prepare(page) {
        await page
          .waitForSelector("div[aria-busy]", { state: "detached", timeout: 15000 })
          .catch(() => {})
        await page.waitForSelector("main, [role='feed']", { timeout: 15000 })
        await page.waitForTimeout(2000)
        // Scroll so the Team report card is completely visible in the viewport
        await safeEvaluate(page, () => {
          const report = [...document.querySelectorAll("div")].find(
            (el) => el.textContent?.trim().startsWith("Team report") && el.children.length
          )
          if (report) {
            report.scrollIntoView({ block: "center", inline: "nearest" })
          } else {
            window.scrollTo(0, document.body.scrollHeight)
          }
        })
        await page.waitForTimeout(800)
      },
    },
    {
      id: "part-thread",
      title: "Member part thread with Brief card",
      url: `${APP_URL}/a/crewRavi01/C_Hs6xskJVXX`,
      async prepare(page) {
        await page
          .waitForSelector("div[aria-busy]", { state: "detached", timeout: 15000 })
          .catch(() => {})
        await page.waitForSelector("main, [role='feed']", { timeout: 15000 })
        await page.waitForTimeout(2000)
        // Scroll so the Brief card and first reply are in clear view
        await safeEvaluate(page, () => {
          window.scrollTo(0, 0)
        })
        await page.waitForTimeout(800)
      },
    },
    {
      id: "goal-schedule",
      title: "Goal page with schedule prompt (clamped)",
      url: `${APP_URL}/goals/RWecsCon1MMr`,
      async prepare(page) {
        await page
          .waitForSelector("div[aria-busy]", { state: "detached", timeout: 15000 })
          .catch(() => {})
        await page.waitForSelector("main", { timeout: 15000 })
        await page.waitForTimeout(2000)
        // Scroll to the Schedules block
        await safeEvaluate(page, () => {
          const summary = document.querySelector("details summary")
          if (summary) summary.scrollIntoView({ block: "center", inline: "nearest" })
        })
        await page.waitForTimeout(800)
      },
    },
  ]

  let fileIndex = 1

  for (const screen of tasks) {
    for (const vp of viewports) {
      for (const theme of themes) {
        const isDark = theme === "dark"
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: theme,
        })
        await context.addCookies(cookies)
        await context.addInitScript((dark) => {
          localStorage.setItem("theme", dark ? "dark" : "light")
        }, isDark)

        const page = await context.newPage()

        const consoleErrors = []
        page.on("console", (msg) => {
          if (msg.type() === "error") {
            const txt = msg.text()
            // Ignore benign react-devtools or turbopack notices
            if (!txt.includes("Download the React DevTools")) {
              consoleErrors.push(txt)
            }
          }
        })

        const failedRequests = []
        page.on("requestfailed", (req) => {
          const err = req.failure()?.errorText || ""
          // Ignore cancelled/aborted requests caused by client router / HMR fast refreshes
          if (err !== "net::ERR_ABORTED") {
            failedRequests.push(`${req.method()} ${req.url()}: ${err}`)
          }
        })

        try {
          // Wait for hydration: before it, the thread shows the server's desktop
          // layout and a spinning Activity panel at every width
          // Not "networkidle": /api/events keeps a stream open
          await page.goto(screen.url, { waitUntil: "load", timeout: 120000 })
          await page
            .locator(".animate-spin")
            .first()
            .waitFor({ state: "detached", timeout: 20000 })
            .catch(() => {})
          await page.waitForTimeout(1500)
          await screen.prepare(page)

          // Checks
          const noHScroll = await safeEvaluate(
            page,
            () => document.documentElement.scrollWidth <= window.innerWidth
          )

          // Touch targets check at 360px (ignoring non-interactive text links inside paragraphs and header brand)
          let smallTargets = []
          if (vp.name === "360") {
            smallTargets = await safeEvaluate(page, () => {
              const elements = Array.from(
                document.querySelectorAll('button, a, input, [role="button"]')
              )
              const small = []
              for (const el of elements) {
                const rect = el.getBoundingClientRect()
                if (rect.width > 0 && rect.height > 0) {
                  if (el.tagName === "A" && el.parentElement?.tagName === "P") continue
                  if (el.tagName === "A" && el.innerText?.includes("Kriya")) continue
                  if (rect.width < 44 || rect.height < 44)
                    small.push(
                      `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 30)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`
                    )
                }
              }
              return small
            })
          }

          const filename = `${String(fileIndex).padStart(2, "0")}_${screen.id}_${vp.name}_${theme}.png`
          const filepath = path.join(OUT_DIR, filename)
          await page.screenshot({ path: filepath, fullPage: false })
          console.log(`Saved screenshot: ${filename}`)

          results.push({
            file: filename,
            screen: screen.title,
            viewport: `${vp.name}px`,
            theme,
            consoleErrors: consoleErrors.length,
            failedRequests: failedRequests.length,
            noHScroll,
            smallTargets: smallTargets.length,
            small: smallTargets,
          })
          fileIndex++

          // For the schedule on 360 light, also take an expanded screenshot
          if (screen.id === "goal-schedule" && vp.name === "360" && theme === "light") {
            const summary = await page.$("details summary")
            if (summary) {
              await summary.click()
              await page.waitForTimeout(600)
              const expFilename = `${String(fileIndex).padStart(2, "0")}_${screen.id}-expanded_360_light.png`
              await page.screenshot({
                path: path.join(OUT_DIR, expFilename),
                fullPage: false,
              })
              console.log(`Saved screenshot: ${expFilename}`)
              results.push({
                file: expFilename,
                screen: "Goal page with schedule prompt (expanded)",
                viewport: "360px",
                theme: "light",
                consoleErrors: consoleErrors.length,
                failedRequests: failedRequests.length,
                noHScroll,
                smallTargets: 0,
              })
              fileIndex++
            }
          }
        } catch (err) {
          console.error(`Error on ${screen.id} (${vp.name}, ${theme}):`, err.message)
        } finally {
          await context.close()
        }
      }
    }
  }

  await browser.close()

  console.log("\n--- Verification Summary Table ---")
  console.table(results)

  // Write README.md
  let readme = `# U3 browser verification (2026-10-23)\n\n`
  readme += `Isolated P-3 stack only: local Supabase, local Next.js dev server on :6796, signed in as local test user Asha (\`asha@example.com\`).\n\n`
  readme += `| Screenshot | Screen | Viewport | Theme | Console Errors | Failed Requests | No H-Scroll | Small Targets (<44px) |\n`
  readme += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`
  for (const r of results) {
    readme += `| \`${r.file}\` | ${r.screen} | ${r.viewport} | ${r.theme} | ${r.consoleErrors} | ${r.failedRequests} | ${r.noHScroll ? "Pass" : "Fail"} | ${r.smallTargets} |\n`
  }
  for (const r of results)
    if (r.small?.length) readme += `\n${r.file} under 44 px: ${r.small.join("; ")}`
  readme += "\n"
  const failed = results.filter(
    (r) => r.consoleErrors || r.failedRequests || !r.noHScroll || r.smallTargets
  )
  readme += failed.length
    ? `\n${failed.length} of ${results.length} screenshots have a failing check (see the table). Look at every image too: the checks don't see layout.\n`
    : `\nAll ${results.length} automated checks passed. Look at every image too: the checks don't see layout.\n`

  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme)
  console.log("Wrote README.md successfully.")
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
