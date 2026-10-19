import { and, eq, sql } from "drizzle-orm"

import { privileged } from "@/db"
import { browserSessions, type TaskInput } from "@/db/schema"
import type { LoadedProfile } from "@/lib/agent/policy"
import { HttpBrowserProvider } from "@/lib/browser/client"
import {
  expireProfile,
  meterClosed,
  profileForTask,
  refreshProfile,
  signedOut,
  type TaskProfile,
} from "@/lib/browser/profiles"
import type {
  ActionResult,
  BrowserAction,
  BrowserProvider,
  PageView,
  StorageState,
} from "@/lib/browser/provider"
import { registrableDomain } from "@/lib/browser/sites"

// One task's browser, from the worker's side: opened on the first browser
// step (within the plan's minutes, checked in SQL), kept alive by the task
// heartbeat, closed and metered when the task ends. The privileged writes
// are bookkeeping for this task, scoped by its user id.

let forTests: BrowserProvider | null = null

export function setBrowserProviderForTests(provider: BrowserProvider | null) {
  forTests = provider
}

// kriya-browser, when the worker is configured for it
export function browserProvider(): BrowserProvider | null {
  if (forTests) return forTests
  const url = process.env.KRIYA_BROWSER_URL?.trim()
  const secret = process.env.KRIYA_BROWSER_SECRET?.trim()
  return url && secret ? new HttpBrowserProvider(url, secret) : null
}

// TOOLS_AND_CONTRACTS.md §1 (A3 moves this to the shared tool contract)
export type Verification = {
  status: "verified" | "unverified" | "failed"
  method: "api_readback" | "page_check" | "file" | "none"
  evidence: { kind: "file" | "url" | "provider_id"; value: string }[]
  note?: string
}

// The evidence an approved commit leaves (BROWSER §3.4, AT-BRW-05): the
// before screenshot, the click, the after screenshot, and a check of the
// page. Not called by the runner until approved steps can run in the session
// that saw them (AF-27).
export async function commitWithEvidence(
  provider: BrowserProvider,
  sessionId: string,
  ref: string,
  expect: { text: string }
): Promise<{ verification: Verification; before?: string; after?: string }> {
  const before = await provider.act(sessionId, { action: "screenshot" })
  if (!before.ok) {
    return {
      verification: {
        status: "failed",
        method: "none",
        evidence: [],
        note: before.message,
      },
    }
  }
  const click = await provider.act(sessionId, { action: "click", ref, intent: "commit" })
  const after = await provider.act(sessionId, { action: "screenshot" })
  const shots = [before, after].flatMap((shot) =>
    shot.ok && shot.screenshot ? [shot.screenshot.sha256] : []
  )
  const evidence: Verification["evidence"] = shots.map((hash) => ({
    kind: "file",
    value: `sha256:${hash}`,
  }))
  if (after.ok) evidence.push({ kind: "url", value: after.snapshot.facts.url })
  const seen = after.ok && after.snapshot.text.includes(expect.text)
  return {
    verification: {
      status: !click.ok ? "failed" : seen ? "verified" : "unverified",
      method: "page_check",
      evidence,
      note: click.ok
        ? `Looked for "${expect.text}" on the page after the click`
        : click.message,
    },
    before: before.screenshot?.sha256,
    after: after.ok ? after.screenshot?.sha256 : undefined,
  }
}

const BLANK: PageView = {
  elements: [],
  facts: {
    url: "about:blank",
    domain: "",
    hasForm: false,
    focusedSensitive: false,
    captcha: false,
  },
}

export class TaskBrowser {
  private opening: Promise<string> | null = null
  private sessionId: string | null = null
  private openedAt = 0
  // The login profile loaded into this session (A6), if any
  private profile: { id: string; domain: string; expired: boolean } | null = null
  // The page as of the last step: what the policy decides from
  view: PageView = BLANK

  constructor(
    private readonly provider: BrowserProvider,
    private readonly task: {
      id: string
      userId: string
      input?: Pick<TaskInput, "channel" | "scheduleId">
    },
    // agents.loginProfiles: use the person's saved sign-in for a site
    readonly options: { profiles?: boolean } = {}
  ) {}

  // For the policy: signed in as the person on these sites
  get loaded(): LoadedProfile {
    return this.profile && !this.profile.expired
      ? { domains: [this.profile.domain] }
      : null
  }

  private session(first: BrowserAction) {
    this.opening ??= this.start(first)
    return this.opening
  }

  private async start(first: BrowserAction) {
    // The first page decides the site; its login profile, if the person
    // saved one, comes along and keeps the session on that site
    let profile: TaskProfile | null = null
    if (this.options.profiles && first.action === "open") {
      try {
        profile = await profileForTask(
          this.task,
          registrableDomain(new URL(first.url).hostname)
        )
      } catch {}
    }
    const { sessionId } = await this.provider.open({
      taskId: this.task.id,
      userId: this.task.userId,
      ...(profile && { state: profile.state, allowedDomains: [profile.domain] }),
    })
    if (profile) {
      this.profile = { id: profile.id, domain: profile.domain, expired: false }
    }
    try {
      await privileged.execute(
        sql`select kriya.open_browser_session(${sessionId}::uuid, ${this.task.id}::uuid, 'kriya-browser')`
      )
    } catch (error) {
      await this.provider.close(sessionId).catch(() => {})
      // Drizzle wraps the database's message in `cause`
      const { message, cause } = error as {
        message?: string
        cause?: { message?: string }
      }
      const minutes = /browser minutes/.test(`${message} ${cause?.message}`)
      throw new Error(
        minutes
          ? "This month's browser minutes are used up."
          : "The browser couldn't be started for this task."
      )
    }
    if (this.profile) {
      await privileged
        .update(browserSessions)
        .set({ loginProfileId: this.profile.id })
        .where(
          and(
            eq(browserSessions.id, sessionId),
            eq(browserSessions.userId, this.task.userId)
          )
        )
    }
    this.sessionId = sessionId
    this.openedAt = Date.now()
    return sessionId
  }

  async act(action: BrowserAction): Promise<ActionResult> {
    const result = await this.provider.act(await this.session(action), action)
    if (result.snapshot) this.view = result.snapshot
    const profile = this.profile
    if (
      profile &&
      !profile.expired &&
      result.ok &&
      signedOut(result.snapshot, profile.domain)
    ) {
      // The site wants a sign-in again: the saved one has expired
      profile.expired = true
      await expireProfile(this.task.userId, profile.id)
      return {
        ok: false,
        error: "login_required",
        message: `The saved login for ${profile.domain} has expired. Ask the person to sign in again under Account → Logins.`,
        snapshot: result.snapshot,
      }
    }
    return result
  }

  // Take-over is offered for a site when its login can be saved
  get signInOffered() {
    return Boolean(this.options.profiles)
  }

  async heartbeat() {
    if (this.sessionId) await this.provider.heartbeat(this.sessionId).catch(() => false)
  }

  async close() {
    const id = this.sessionId
    if (!id) return
    // The next browser step opens a fresh session
    const profile = this.profile
    this.sessionId = null
    this.opening = null
    this.profile = null
    this.view = BLANK
    const refresh = Boolean(profile && !profile.expired)
    const elapsed = Math.round((Date.now() - this.openedAt) / 1000)
    const { seconds, state } = await this.provider
      .close(id, refresh)
      .catch((): { seconds: number; state?: StorageState } => ({ seconds: elapsed }))
    await meterClosed(this.task.userId, id, this.task.id, seconds)
    if (refresh && profile && state) {
      await refreshProfile(this.task.userId, profile.id, profile.domain, state).catch(
        () => {}
      )
    }
  }
}
