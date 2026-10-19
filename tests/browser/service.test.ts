import fs from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createBrowserService } from "@/browser/index"
import { classifyBrowserAction } from "@/lib/agent/policy"
import { HttpBrowserProvider } from "@/lib/browser/client"
import type { PageElement, Snapshot } from "@/lib/browser/provider"
import { commitWithEvidence } from "@/lib/browser/session"
import { renderSnapshot, SNAPSHOT_TOKEN_BUDGET } from "@/lib/browser/snapshot"

import { FIXTURE_SITES, startFixtureSites } from "../fixtures/sites"

// The real kriya-browser on an ephemeral port, driven through the worker's
// HTTP client, against the local fixture sites (AD-23). Needs Chromium:
// KRIYA_TEST_BROWSER=1 (BROWSER_CHROMIUM_PATH picks a local build).

const enabled = process.env.KRIYA_TEST_BROWSER === "1"
if (!enabled) {
  console.info("browser tests skipped: set KRIYA_TEST_BROWSER=1 to run them")
}

const SECRET = "test-secret-".padEnd(48, "x")
const noDns = async (): Promise<string[]> => {
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" })
}

describe.skipIf(!enabled)("kriya-browser on fixture sites", () => {
  let sites: Awaited<ReturnType<typeof startFixtureSites>>
  let service: Awaited<ReturnType<typeof createBrowserService>>
  let browser: HttpBrowserProvider

  beforeAll(async () => {
    sites = await startFixtureSites()
    service = await createBrowserService({
      secret: SECRET,
      fixtures: sites.hosts,
      // Nothing else resolves: no real site, no real DNS
      lookup: noDns,
      executablePath: process.env.BROWSER_CHROMIUM_PATH || undefined,
      limits: { idleSeconds: 2, perMinute: 120, perSession: 200 },
    })
    browser = new HttpBrowserProvider(service.url, SECRET)
  }, 60_000)

  afterAll(async () => {
    await service?.close()
    await sites?.close()
  })

  const session = async () =>
    (await browser.open({ taskId: crypto.randomUUID(), userId: crypto.randomUUID() }))
      .sessionId

  const go = async (id: string, url: string) => {
    const result = await browser.act(id, { action: "open", url })
    if (!result.ok) throw new Error(`${result.error}: ${result.message}`)
    return result.snapshot
  }

  const find = (snapshot: Snapshot, name: string) => {
    const element = snapshot.elements.find((e) => e.name === name)
    if (!element) {
      throw new Error(`no element ${name} in ${snapshot.elements.map((e) => e.name)}`)
    }
    return element as PageElement
  }

  it("refuses requests without the service secret", async () => {
    const res = await fetch(`${service.url}/sessions`, { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
    const wrong = new HttpBrowserProvider(service.url, "nope".padEnd(48, "y"))
    await expect(wrong.open({ taskId: "t", userId: "u" })).rejects.toThrow(/401/)
  })

  it("AT-BRW-01 opens, acts and closes a session", async () => {
    const id = await session()
    let page = await go(id, sites.url("profile-editor"))
    expect(page.title).toBe("Edit profile")
    expect(page.facts).toMatchObject({
      domain: "fixture.test",
      hasForm: true,
      captcha: false,
    })

    const headline = find(page, "Headline")
    expect(headline).toMatchObject({ role: "textbox", inForm: true, sensitive: false })
    const typed = await browser.act(id, {
      action: "type",
      ref: headline.ref,
      text: "Final-year B.Tech student",
    })
    if (!typed.ok) throw new Error(typed.message)
    page = typed.snapshot
    expect(find(page, "Headline").value).toBe("Final-year B.Tech student")

    const saved = await browser.act(id, { action: "click", ref: find(page, "Save").ref })
    expect(saved.ok && saved.snapshot.text).toContain("Saved")

    expect((await browser.close(id)).seconds).toBeGreaterThanOrEqual(0)
    const after = await browser.act(id, { action: "snapshot" })
    expect(after).toMatchObject({ ok: false, error: "stopped" })
  })

  it("AT-BRW-01 a session without heartbeats is closed", async () => {
    const id = await session()
    await go(id, sites.url("profile-editor"))
    expect(await browser.heartbeat(id)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    expect(await browser.heartbeat(id)).toBe(false)
    expect(await browser.act(id, { action: "snapshot" })).toMatchObject({
      error: "stopped",
    })
  })

  it("AT-BRW-02 snapshots never carry a password, OTP or Aadhaar value", async () => {
    const id = await session()
    const page = await go(id, sites.url("signup"))
    const raw = JSON.stringify(page)
    for (const secret of ["fixture-secret-hunter2", "482913", "1234 5678 9012"]) {
      expect(raw).not.toContain(secret)
    }
    for (const name of ["Password", "Email code", "Aadhaar number"]) {
      const field = find(page, name)
      expect(field.sensitive, name).toBe(true)
      expect(field.value, name).toBeUndefined()
    }
    expect(page.facts).toMatchObject({ focusedSensitive: true, captcha: true })
    await browser.close(id)
  })

  it("refuses to type into a sensitive field even if asked directly (R5)", async () => {
    const id = await session()
    const page = await go(id, sites.url("signup", "/no-captcha"))
    const result = await browser.act(id, {
      action: "type",
      ref: find(page, "Password").ref,
      text: "guess",
    })
    expect(result).toMatchObject({ ok: false, error: "sensitive" })
    await browser.close(id)
  })

  it("AT-BRW-03 takes no screenshot while a sensitive field is focused", async () => {
    const id = await session()
    await go(id, sites.url("signup"))
    expect(await browser.act(id, { action: "screenshot" })).toMatchObject({
      ok: false,
      error: "sensitive",
    })
    await go(id, sites.url("signup", "/no-captcha"))
    const shot = await browser.act(id, { action: "screenshot" })
    if (!shot.ok) throw new Error(shot.message)
    expect(shot.screenshot?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(shot.screenshot?.bytes).toBeGreaterThan(0)
    await browser.close(id)
  })

  it("AT-BRW-04 every fixture's snapshot, and its diff, stays under the budget", async () => {
    const id = await session()
    for (const site of FIXTURE_SITES) {
      const page = await go(id, sites.url(site))
      const tokens = Math.ceil(renderSnapshot(page).length / 4)
      expect(tokens, site).toBeLessThanOrEqual(SNAPSHOT_TOKEN_BUDGET)
    }
    const long = await go(id, sites.url("feed", "/long"))
    expect(long.elements.length).toBeLessThanOrEqual(120)
    expect(Math.ceil(renderSnapshot(long).length / 4)).toBeLessThanOrEqual(
      SNAPSHOT_TOKEN_BUDGET
    )

    // The slow page: the button appears later and shows up as a diff
    await go(id, sites.url("slow"))
    // Look again until it appears (no fixed sleep: test files run in parallel)
    let later = await browser.snapshot(id)
    for (
      let i = 0;
      i < 40 && !later.elements.some((e) => e.name === "Show details");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      later = await browser.snapshot(id)
    }
    expect(later.diff?.added).toContain('button "Show details"')
    expect(renderSnapshot(later, { diffOnly: true }).length).toBeLessThan(
      renderSnapshot(later).length
    )
    await browser.close(id)
  })

  it("AT-POL-03 on a real page: Hindi and Telugu save buttons are commits", async () => {
    const id = await session()
    const page = await go(id, sites.url("hindi-telugu"))
    const rule = { domain: "fixture.test", mode: "supervised" as const, reviewed: null }
    for (const name of ["सहेजें", "సేవ్ చేయి"]) {
      const action = { action: "click" as const, ref: find(page, name).ref }
      expect(classifyBrowserAction(action, page, rule), name).toBe("R4")
    }
    const more = { action: "click" as const, ref: find(page, "और देखें").ref }
    expect(classifyBrowserAction(more, page, rule)).toBe("R0")
    await browser.close(id)
  })

  it("AT-BRW-06 the browser can't reach loopback, metadata or private addresses", async () => {
    const id = await session()
    for (const url of [
      `http://127.0.0.1:${sites.port}/secret`,
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://localhost/",
      "file:///etc/passwd",
    ]) {
      const result = await browser.act(id, { action: "open", url })
      expect(result.ok, url).toBe(false)
    }
    for (const name of ["One", "Two", "Three"]) {
      const page = await go(id, sites.url("redirect-internal"))
      const result = await browser.act(id, { action: "click", ref: find(page, name).ref })
      expect(result.ok, name).toBe(false)
    }
    expect(sites.requests.filter((r) => r.includes("/secret"))).toEqual([])
    await browser.close(id)
  })

  it("AT-BRW-07 two people's sessions share no cookies, storage or files", async () => {
    const a = await session()
    const b = await session()
    const pageA = await go(a, sites.url("profile-editor"))
    const typed = await browser.act(a, {
      action: "type",
      ref: find(pageA, "Headline").ref,
      text: "Person A's headline",
    })
    if (!typed.ok) throw new Error(typed.message)
    await browser.act(a, { action: "click", ref: find(typed.snapshot, "Save").ref })

    const pageB = await go(b, sites.url("profile-editor"))
    expect(pageB.text).toContain("No headline yet")
    expect(pageB.text).not.toContain("Person A")

    const dirs = service.profileDirs()
    expect(dirs).toHaveLength(2)
    expect(new Set(dirs).size).toBe(2)
    await browser.close(a)
    await browser.close(b)
    // Windows can release the profile's file handles a moment after close
    // under load: wait up to 1 s, every 100 ms
    const gone = async (dir: string) => {
      for (let i = 0; i < 10 && fs.existsSync(dir); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return !fs.existsSync(dir)
    }
    for (const dir of dirs) expect(await gone(dir), dir).toBe(true)
  })

  it("AT-BRW-10 uploads go only into a file field, only with the worker's bytes", async () => {
    const id = await session()
    const page = await go(id, sites.url("job-application"))
    const next = await browser.act(id, { action: "click", ref: find(page, "Next").ref })
    if (!next.ok) throw new Error(next.message)
    const resume = find(next.snapshot, "Resume")
    expect(resume.type).toBe("file")
    const file = { name: "resume.pdf", mime: "application/pdf", data: btoa("%PDF-1.4\n") }
    // No bytes from kriya.files: refused
    expect(
      await browser.act(id, { action: "upload", ref: resume.ref, fileId: "f1" })
    ).toMatchObject({ ok: false, error: "blocked" })
    // Not a file field: refused
    expect(
      await browser.act(id, {
        action: "upload",
        ref: find(next.snapshot, "Next").ref,
        fileId: "f1",
        file,
      })
    ).toMatchObject({ ok: false, error: "blocked" })
    expect(
      await browser.act(id, { action: "upload", ref: resume.ref, fileId: "f1", file })
    ).toMatchObject({ ok: true })
    await browser.close(id)
  })

  it("AT-BRW-09 downloads are refused", async () => {
    const id = await session()
    const page = await go(id, sites.url("bill-portal"))
    expect(page.text).toContain("₹1,180.00")
    const result = await browser.act(id, {
      action: "click",
      ref: find(page, "Download September bill").ref,
    })
    expect(result).toMatchObject({ ok: false, error: "blocked" })
    await browser.close(id)
  })

  it("a ref whose element changed since the snapshot is refused, not clicked", async () => {
    const id = await session()
    const page = await go(id, sites.url("injection", "/shifty"))
    const button = find(page, "Show more")
    // The page renames the button to "Pay now" after the snapshot
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const result = await browser.act(id, { action: "click", ref: button.ref })
    expect(result).toMatchObject({ ok: false, error: "not_found" })
    expect(result.ok ? "" : result.snapshot?.text).not.toContain("Paid")
    await browser.close(id)
  })

  it("AT-BRW-05 (evidence part) an approved commit leaves before/after screenshots and a page check", async () => {
    const id = await session()
    const page = await go(id, sites.url("profile-editor"))
    const typed = await browser.act(id, {
      action: "type",
      ref: find(page, "Headline").ref,
      text: "Open to internships",
    })
    if (!typed.ok) throw new Error(typed.message)
    const save = find(typed.snapshot, "Save").ref
    const done = await commitWithEvidence(browser, id, save, { text: "Saved" })
    expect(done.verification).toMatchObject({ status: "verified", method: "page_check" })
    expect(done.before).toMatch(/^[0-9a-f]{64}$/)
    expect(done.after).toMatch(/^[0-9a-f]{64}$/)
    expect(done.after).not.toBe(done.before)
    expect(done.verification.evidence).toEqual(
      expect.arrayContaining([{ kind: "file", value: `sha256:${done.after}` }])
    )

    // The expected text never appears: recorded as unverified, never as done
    const again = await go(id, sites.url("profile-editor"))
    const missing = await commitWithEvidence(browser, id, find(again, "Save").ref, {
      text: "Published to everyone",
    })
    expect(missing.verification.status).toBe("unverified")
    await browser.close(id)
  })

  it("/render/pdf returns a PDF and makes no network request", async () => {
    const before = sites.requests.length
    const pdf = await browser.renderPdf(
      `<!doctype html><html><body><h1>Invoice ₹1,18,000.00</h1>
      <img src="${sites.url("bill-portal", "/pixel.png")}">
      <script>document.body.append("script ran")</script></body></html>`
    )
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-")
    expect(sites.requests.slice(before)).toEqual([])
  })
})

describe.skipIf(!enabled)("AT-BRW-11 rate limits", () => {
  let sites: Awaited<ReturnType<typeof startFixtureSites>>
  let service: Awaited<ReturnType<typeof createBrowserService>>
  let browser: HttpBrowserProvider

  beforeAll(async () => {
    sites = await startFixtureSites()
    service = await createBrowserService({
      secret: SECRET,
      fixtures: sites.hosts,
      lookup: noDns,
      executablePath: process.env.BROWSER_CHROMIUM_PATH || undefined,
      limits: { perMinute: 5, perSession: 8 },
    })
    browser = new HttpBrowserProvider(service.url, SECRET)
  }, 60_000)

  afterAll(async () => {
    await service?.close()
    await sites?.close()
  })

  it("stops at the per-minute cap", async () => {
    const { sessionId } = await browser.open({ taskId: "t1", userId: "u1" })
    const results = []
    for (let i = 0; i < 6; i++) {
      results.push(await browser.act(sessionId, { action: "snapshot" }))
    }
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true)
    expect(results[5]).toMatchObject({ ok: false, error: "rate_limited" })
    await browser.close(sessionId)
  })

  it("three identical failures stop the session", async () => {
    const { sessionId } = await browser.open({ taskId: "t2", userId: "u2" })
    await browser.act(sessionId, { action: "open", url: sites.url("profile-editor") })
    const click = { action: "click" as const, ref: "e999" }
    expect(await browser.act(sessionId, click)).toMatchObject({ error: "not_found" })
    expect(await browser.act(sessionId, click)).toMatchObject({ error: "not_found" })
    expect(await browser.act(sessionId, click)).toMatchObject({ error: "stopped" })
    expect(await browser.act(sessionId, { action: "snapshot" })).toMatchObject({
      error: "stopped",
    })
  })
})
