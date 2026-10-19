import { isIP } from "node:net"

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"

import { privileged } from "@/db"
import {
  browserSessions,
  loginProfiles,
  resourceUsage,
  schedules,
  type TaskInput,
} from "@/db/schema"
import type { BrowserProvider, PageView, StorageState } from "@/lib/browser/provider"
import { registrableDomain, siteFor } from "@/lib/browser/sites"
import { log } from "@/lib/log"
import { keyId, needsReseal, open, seal } from "@/lib/secrets"

// Login profiles (AD-05, BROWSER_AND_LOGIN_PROFILES.md §6): the person signs
// in themselves during take-over and Kriya keeps the browser's session
// state, never a password. The state is sealed with lib/secrets.ts, bound to
// "<user id>:login:<profile id>", and opened only here, for one
// kriya-browser session (invariant 4). The privileged writes are the
// server's bookkeeping, each scoped by the user id it was given.

// Re-confirmation after 90 days, and expiry after 90 days unused
export const PROFILE_DAYS = 90
const DAY = 86_400_000
// A sealed state stays well under the column's 1,000,000 characters
export const MAX_STATE_BYTES = 512 * 1024

const context = (userId: string, profileId: string) => `${userId}:login:${profileId}`

const onDomain = (host: string, domain: string) => {
  const name = host.toLowerCase().replace(/^\./, "")
  return name === domain || name.endsWith(`.${domain}`)
}

// Only what belongs to the profile's site is kept
export function scopeState(state: StorageState, domain: string): StorageState {
  return {
    cookies: state.cookies.filter((cookie) => onDomain(cookie.domain, domain)),
    origins: state.origins.filter((origin) => {
      try {
        return onDomain(new URL(origin.origin).hostname, domain)
      } catch {
        return false
      }
    }),
  }
}

export const isEmptyState = (state: StorageState) =>
  state.cookies.length === 0 && state.origins.every((o) => o.localStorage.length === 0)

export function sealState(userId: string, profileId: string, state: StorageState) {
  const json = JSON.stringify(state)
  if (Buffer.byteLength(json) > MAX_STATE_BYTES) {
    throw new Error("This site's sign-in is too large to keep.")
  }
  return seal(json, context(userId, profileId))
}

// Throws if the ciphertext was moved to another row or user (AT-SEC-02)
export function openState(userId: string, profileId: string, sealed: string) {
  return JSON.parse(open(sealed, context(userId, profileId))) as StorageState
}

// The profile's site is asking to sign in again: a password field on it
export function signedOut(view: PageView, domain: string) {
  return (
    onDomain(view.facts.domain, domain) &&
    view.elements.some((e) => e.sensitive && e.type === "password")
  )
}

const stale = (
  row: { expiresAt: Date | null; lastUsedAt: Date | null; confirmedAt: Date | null },
  now: number
) =>
  (row.expiresAt?.getTime() ?? 0) < now ||
  (row.lastUsedAt ?? row.confirmedAt ?? new Date(0)).getTime() < now - PROFILE_DAYS * DAY

export async function expireProfile(userId: string, profileId: string) {
  await privileged
    .update(loginProfiles)
    .set({ status: "expired", stateSealed: null })
    .where(
      and(
        eq(loginProfiles.id, profileId),
        eq(loginProfiles.userId, userId),
        eq(loginProfiles.status, "active")
      )
    )
}

export type TaskProfile = { id: string; domain: string; state: StorageState }

// The profile a task may use on this site, opened for its one session. A
// scheduled run needs background use allowed on both the profile and the
// schedule (AT-SCH-06).
export async function profileForTask(
  task: { userId: string; input?: Pick<TaskInput, "channel" | "scheduleId"> },
  domain: string,
  now = Date.now()
): Promise<TaskProfile | null> {
  const [row] = await privileged
    .select()
    .from(loginProfiles)
    .where(
      and(
        eq(loginProfiles.userId, task.userId),
        eq(loginProfiles.domain, domain),
        eq(loginProfiles.status, "active")
      )
    )
    .orderBy(sql`${loginProfiles.lastUsedAt} desc nulls last`)
    .limit(1)
  if (!row?.stateSealed) return null
  if (stale(row, now)) {
    await expireProfile(task.userId, row.id)
    return null
  }
  if (task.input?.channel === "schedule") {
    if (!row.backgroundAllowed || !task.input.scheduleId) return null
    const [schedule] = await privileged
      .select({ backgroundAllowed: schedules.backgroundAllowed })
      .from(schedules)
      .where(
        and(eq(schedules.id, task.input.scheduleId), eq(schedules.userId, task.userId))
      )
    if (!schedule?.backgroundAllowed) return null
  }
  let state: StorageState
  try {
    state = openState(task.userId, row.id, row.stateSealed)
  } catch (error) {
    // Unreadable (key changed, or not this row's): the person signs in again
    log.warn("login profile could not be opened", { profileId: row.id, error })
    await expireProfile(task.userId, row.id)
    return null
  }
  await privileged
    .update(loginProfiles)
    .set({
      lastUsedAt: new Date(now),
      // Key rotation: sealed again with the current key as it's used
      ...(needsReseal(row.stateSealed) && {
        stateSealed: sealState(task.userId, row.id, state),
      }),
    })
    .where(and(eq(loginProfiles.id, row.id), eq(loginProfiles.userId, task.userId)))
  return { id: row.id, domain, state }
}

// After a task: the site may have rotated its cookies (active → active)
export async function refreshProfile(
  userId: string,
  profileId: string,
  domain: string,
  state: StorageState
) {
  const scoped = scopeState(state, domain)
  if (isEmptyState(scoped)) return
  await privileged
    .update(loginProfiles)
    .set({ stateSealed: sealState(userId, profileId, scoped) })
    .where(
      and(
        eq(loginProfiles.id, profileId),
        eq(loginProfiles.userId, userId),
        eq(loginProfiles.status, "active")
      )
    )
}

// A closed session's time, in the plan's browser minutes (invariant 7)
export async function meterClosed(
  userId: string,
  sessionId: string,
  taskId: string | null,
  seconds: number,
  status: "closed" | "failed" = "closed"
) {
  await privileged
    .update(browserSessions)
    .set({ status, closedAt: new Date(), seconds })
    .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.userId, userId)))
  // Unpriced until the owner enters a cost basis (invariant 6)
  await privileged
    .insert(resourceUsage)
    .values({
      requestKey: `browser:${sessionId}`,
      userId,
      taskId,
      kind: "browser_seconds",
      quantity: seconds,
    })
    .onConflictDoNothing()
}

/* ─────────────────── take-over sign-in (kriya-web) ─────────────────── */

export class ProfileError extends Error {
  name = "ProfileError"
}

const OPEN = ["open", "paused"] as const

async function loginSession(userId: string, profileId: string) {
  const [row] = await privileged
    .select({ id: browserSessions.id, openedAt: browserSessions.openedAt })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, userId),
        eq(browserSessions.loginProfileId, profileId),
        isNull(browserSessions.taskId),
        inArray(browserSessions.status, OPEN)
      )
    )
    .orderBy(desc(browserSessions.openedAt))
    .limit(1)
  return row ?? null
}

// The person's open take-over session for this profile, for the live view
export async function signInSession(userId: string, profileId: string) {
  return (await loginSession(userId, profileId))?.id ?? null
}

async function closeLogin(
  provider: BrowserProvider,
  userId: string,
  session: { id: string; openedAt: Date },
  capture: boolean
) {
  const elapsed = Math.round((Date.now() - session.openedAt.getTime()) / 1000)
  const result = await provider
    .close(session.id, capture)
    .catch((): { seconds: number; state?: StorageState } => ({ seconds: elapsed }))
  await meterClosed(userId, session.id, null, result.seconds)
  return result.state
}

const causeText = (error: unknown) =>
  `${(error as Error)?.message} ${(error as { cause?: Error })?.cause?.message}`

// Opens Kriya's browser on the site's sign-in page, handed to the person.
// `profileId` signs in again to an existing profile (expired, or due).
export async function startSignIn(
  provider: BrowserProvider,
  userId: string,
  input: { url: string; label?: string; profileId?: string }
) {
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`)
  } catch {
    throw new ProfileError("That isn't a web address.")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProfileError("Only web pages can be signed in to.")
  }
  const domain = registrableDomain(url.hostname)
  if (isIP(domain) || !domain.includes(".")) {
    throw new ProfileError("Use the site's name, not an address.")
  }
  if (siteFor(url.href)?.mode === "blocked") {
    throw new ProfileError("Kriya doesn't sign in to this site.")
  }

  let profileId = input.profileId
  let created = false
  if (profileId) {
    const [row] = await privileged
      .select({ domain: loginProfiles.domain })
      .from(loginProfiles)
      .where(and(eq(loginProfiles.id, profileId), eq(loginProfiles.userId, userId)))
    if (!row) throw new ProfileError("That login isn't yours or no longer exists.")
    if (row.domain !== domain) {
      throw new ProfileError(`This login is for ${row.domain}.`)
    }
    const previous = await loginSession(userId, profileId)
    if (previous) await closeLogin(provider, userId, previous, false)
  } else {
    try {
      const [row] = await privileged
        .insert(loginProfiles)
        .values({ userId, domain, label: (input.label?.trim() || domain).slice(0, 60) })
        .returning({ id: loginProfiles.id })
      profileId = row.id
      created = true
    } catch (error) {
      const text = causeText(error)
      throw new ProfileError(
        /limit reached/.test(text)
          ? "Your plan's logins are all in use. Remove one first."
          : /unique|duplicate/.test(text)
            ? "You already have a login with that name for this site."
            : "The login couldn't be started."
      )
    }
  }
  const id = profileId

  const discard = async () => {
    if (!created) return
    await privileged
      .delete(loginProfiles)
      .where(and(eq(loginProfiles.id, id), eq(loginProfiles.userId, userId)))
  }
  let sessionId: string
  try {
    ;({ sessionId } = await provider.open({
      taskId: `login:${id}`,
      userId,
      viewport: { width: 390, height: 844 },
    }))
  } catch {
    await discard()
    throw new ProfileError("Kriya's browser is busy. Try again in a minute.")
  }
  try {
    await privileged.execute(
      sql`select kriya.open_login_session(${sessionId}::uuid, ${userId}::uuid, ${id}::uuid, 'kriya-browser')`
    )
  } catch (error) {
    await provider.close(sessionId).catch(() => {})
    await discard()
    throw new ProfileError(
      /browser minutes/.test(causeText(error))
        ? "This month's browser minutes are used up."
        : "The sign-in couldn't be started."
    )
  }
  const opened = await provider.act(sessionId, { action: "open", url: url.href })
  if (!opened.ok && opened.error === "blocked") {
    await closeLogin(provider, userId, { id: sessionId, openedAt: new Date() }, false)
    await discard()
    throw new ProfileError("Kriya's browser can't open that site.")
  }
  await provider.act(sessionId, { action: "handoff", reason: "login" })
  // For the Save dialog: how far agents may go on this site (AD-06)
  const mode = siteFor(url.href)?.mode ?? "read-only"
  return { profileId: id, sessionId, domain, mode }
}

// Ends the take-over: saves the session as the profile's state, or not
export async function finishSignIn(
  provider: BrowserProvider,
  userId: string,
  profileId: string,
  options: { save: boolean; backgroundAllowed?: boolean }
): Promise<"saved" | "discarded" | "empty"> {
  const [row] = await privileged
    .select({ domain: loginProfiles.domain, status: loginProfiles.status })
    .from(loginProfiles)
    .where(and(eq(loginProfiles.id, profileId), eq(loginProfiles.userId, userId)))
  if (!row) throw new ProfileError("That login isn't yours or no longer exists.")
  const session = await loginSession(userId, profileId)
  if (!session && options.save) {
    throw new ProfileError("The sign-in window closed. Start again.")
  }
  const state = session
    ? await closeLogin(provider, userId, session, options.save)
    : undefined
  if (!options.save) {
    if (row.status === "pending") {
      await privileged
        .delete(loginProfiles)
        .where(and(eq(loginProfiles.id, profileId), eq(loginProfiles.userId, userId)))
    }
    return "discarded"
  }
  const scoped = state ? scopeState(state, row.domain) : null
  if (!scoped || isEmptyState(scoped)) return "empty"
  const now = Date.now()
  await privileged
    .update(loginProfiles)
    .set({
      status: "active",
      stateSealed: sealState(userId, profileId, scoped),
      confirmedAt: new Date(now),
      expiresAt: new Date(now + PROFILE_DAYS * DAY),
      ...(options.backgroundAllowed !== undefined && {
        backgroundAllowed: options.backgroundAllowed,
      }),
    })
    .where(and(eq(loginProfiles.id, profileId), eq(loginProfiles.userId, userId)))
  return "saved"
}

/* ────────────────────────── janitor (worker) ───────────────────────── */

// Expired and unused profiles lose their state; sign-ins nobody finished
// are cleared. Runs in the worker's janitor.
export async function profileJanitor(now = new Date()) {
  const unused = new Date(now.getTime() - PROFILE_DAYS * DAY)
  const expired = await privileged
    .update(loginProfiles)
    .set({ status: "expired", stateSealed: null })
    .where(
      and(
        eq(loginProfiles.status, "active"),
        or(
          lt(loginProfiles.expiresAt, now),
          sql`coalesce(${loginProfiles.lastUsedAt}, ${loginProfiles.confirmedAt}) < ${unused.toISOString()}::timestamptz`
        )
      )
    )
    .returning({ id: loginProfiles.id })
  // Pending profiles hold no state; an hour is long enough to sign in
  await privileged
    .delete(loginProfiles)
    .where(
      and(
        eq(loginProfiles.status, "pending"),
        lt(loginProfiles.createdAt, new Date(now.getTime() - 3_600_000))
      )
    )
  // Take-over sessions left open: kriya-browser has closed them (15 minutes
  // at most). ponytail: metered at that 15-minute ceiling, since the actual
  // time went with the session; ask the service for it if plans get tight.
  const abandoned = await privileged
    .select({ id: browserSessions.id, userId: browserSessions.userId })
    .from(browserSessions)
    .where(
      and(
        isNull(browserSessions.taskId),
        inArray(browserSessions.status, OPEN),
        lt(browserSessions.openedAt, new Date(now.getTime() - 30 * 60_000))
      )
    )
    .limit(200)
  for (const session of abandoned) {
    await meterClosed(session.userId, session.id, null, 900, "failed")
  }
  const resealed = process.env.KRIYA_TOKEN_KEY_PREVIOUS?.trim()
    ? await resealProfiles()
    : 0
  return { expired: expired.length, abandoned: abandoned.length, resealed }
}

// Key rotation (runbooks/key-rotation.md): saved logins still sealed with an
// older key are sealed again with the current one, a batch at a time. One
// that won't open with either key is expired; the person signs in again.
export async function resealProfiles(batch = 200) {
  const rows = await privileged
    .select({
      id: loginProfiles.id,
      userId: loginProfiles.userId,
      stateSealed: loginProfiles.stateSealed,
    })
    .from(loginProfiles)
    .where(
      and(
        eq(loginProfiles.status, "active"),
        sql`${loginProfiles.stateSealed} not like ${`v2_${keyId()}.%`}`
      )
    )
    .limit(batch)
  let count = 0
  for (const row of rows) {
    try {
      const state = openState(row.userId, row.id, row.stateSealed!)
      await privileged
        .update(loginProfiles)
        .set({ stateSealed: sealState(row.userId, row.id, state) })
        .where(and(eq(loginProfiles.id, row.id), eq(loginProfiles.userId, row.userId)))
      count++
    } catch {
      await expireProfile(row.userId, row.id)
    }
  }
  return count
}
