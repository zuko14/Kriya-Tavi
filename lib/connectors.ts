import { and, eq } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, withUser } from "@/db"
import { connections, type ConnectionProvider, type Verification } from "@/db/schema"
import { getSecret } from "@/lib/config"
import {
  isSecretsConfigured,
  needsReseal,
  open,
  seal,
  SecretsConfigError,
} from "@/lib/secrets"

// Connected accounts: OAuth with Google and Notion (and, from A8, GitHub and
// Meta for Instagram), the tokens (sealed with lib/secrets.ts, refreshed
// here), and the API calls agents make through the tools in
// lib/agent/tools.ts. Used by the web server for connecting and by the
// worker for tool calls, so nothing here depends on Next.js. The A8
// connectors in lib/connectors/* reach the APIs through providerFetch, so
// tokens are opened only in this file (invariant 4).

export class ConnectorError extends Error {
  name = "ConnectorError"
}

/* ───────────────────────────── services ─────────────────────────── */

export const GOOGLE_SERVICES = {
  calendar: {
    label: "Calendar",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
  },
  gmail: {
    label: "Gmail",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  },
  drive: {
    label: "Drive",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  },
} as const

// A8, opt-in only (agents.connectors): kept out of GOOGLE_SERVICES, which is
// what a connection asks for when nothing was picked. Sheets is a sensitive
// scope that needs Google's app verification before public use (AB-06).
export const GOOGLE_EXTRA_SERVICES = {
  sheets: {
    label: "Sheets",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  },
  youtube: {
    label: "YouTube",
    scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
  },
  // G2 (OD-15, OD-17): sharing a Drive file needs the full Drive scope, a
  // Restricted one; asked only when the person ticks it
  drive_share: {
    label: "Drive sharing",
    scopes: ["https://www.googleapis.com/auth/drive"],
  },
} as const

const ALL_GOOGLE = { ...GOOGLE_SERVICES, ...GOOGLE_EXTRA_SERVICES }

export type GoogleService = keyof typeof ALL_GOOGLE

export const EXTRA_GOOGLE_SERVICES = Object.keys(GOOGLE_EXTRA_SERVICES) as GoogleService[]

export function isGoogleService(value: string): value is GoogleService {
  return value in ALL_GOOGLE
}

// The Google services a set of granted scopes switches on
export function googleServices(scopes: string[]) {
  return (Object.keys(ALL_GOOGLE) as GoogleService[]).filter((service) =>
    ALL_GOOGLE[service].scopes.every((scope) => scopes.includes(scope))
  )
}

/* ─────────────────────────────── OAuth ──────────────────────────── */

// One-time state for a connect attempt: "<provider>.<user id>.<nonce>"
export const OAUTH_STATE_COOKIE = "kriya_oauth"

// Where a connect attempt ends: the account page, with what happened
export function accountUrl(origin: string, params: Record<string, string>) {
  const target = new URL("/account", origin)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  target.hash = "connections"
  return target
}

const OAUTH = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    clientId: () => getSecret("GOOGLE_CLIENT_ID"),
    clientSecret: () => getSecret("GOOGLE_CLIENT_SECRET"),
  },
  notion: {
    authorize: "https://api.notion.com/v1/oauth/authorize",
    token: "https://api.notion.com/v1/oauth/token",
    clientId: () => getSecret("NOTION_CLIENT_ID"),
    clientSecret: () => getSecret("NOTION_CLIENT_SECRET"),
  },
  // A GitHub App: the person picks the repositories when installing it,
  // which is the per-repo grant (TOOLS_AND_CONTRACTS §2.6)
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    clientId: () => getSecret("GITHUB_CLIENT_ID"),
    clientSecret: () => getSecret("GITHUB_CLIENT_SECRET"),
  },
  meta: {
    authorize: "https://www.facebook.com/v21.0/dialog/oauth",
    token: "https://graph.facebook.com/v21.0/oauth/access_token",
    clientId: () => getSecret("META_APP_ID"),
    clientSecret: () => getSecret("META_APP_SECRET"),
  },
} as const

// ponytail: pinned Graph API version; RG-4 checks it is still supported
// before live use (AB-06)
export const META_GRAPH = "https://graph.facebook.com/v21.0"

// Instagram API with Facebook Login, professional accounts only (RG-4)
const META_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
]

export function isProviderConfigured(provider: ConnectionProvider) {
  return (
    !!OAUTH[provider].clientId() &&
    !!OAUTH[provider].clientSecret() &&
    isSecretsConfigured()
  )
}

function credentials(provider: ConnectionProvider) {
  const clientId = OAUTH[provider].clientId()
  const clientSecret = OAUTH[provider].clientSecret()
  if (!clientId || !clientSecret) {
    throw new ConnectorError(`${provider} connections aren't set up on this server.`)
  }
  return { clientId, clientSecret }
}

export function authorizeUrl(
  provider: ConnectionProvider,
  {
    state,
    redirectUri,
    services,
  }: { state: string; redirectUri: string; services: GoogleService[] }
) {
  const { clientId } = credentials(provider)
  const url = new URL(OAUTH[provider].authorize)
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", state)
  if (provider === "google") {
    const scopes = ["openid", "email", ...services.flatMap((s) => ALL_GOOGLE[s].scopes)]
    url.searchParams.set("scope", scopes.join(" "))
    // A refresh token, so agents can work while the person is away
    url.searchParams.set("access_type", "offline")
    url.searchParams.set("prompt", "consent")
  } else if (provider === "notion") {
    url.searchParams.set("owner", "user")
  } else if (provider === "meta") {
    url.searchParams.set("scope", META_SCOPES.join(","))
  }
  // GitHub: a GitHub App's permissions come from the app, not a scope
  return url.toString()
}

type Tokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  scopes: string[]
  account: string | null
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  const json = (await response.json().catch(() => null)) as
    (T & { error?: unknown; error_description?: string; message?: string }) | null
  if (!response.ok || !json) {
    const detail =
      json?.error_description ??
      (typeof json?.error === "object" && json.error
        ? (json.error as { message?: string }).message
        : typeof json?.error === "string"
          ? json.error
          : json?.message)
    throw new ConnectorError(
      `${what} failed (${response.status})${detail ? `: ${String(detail).slice(0, 300)}` : ""}`
    )
  }
  return json
}

export async function exchangeCode(
  provider: ConnectionProvider,
  code: string,
  redirectUri: string
): Promise<Tokens> {
  const { clientId, clientSecret } = credentials(provider)
  if (provider === "google") {
    const token = await readJson<{
      access_token: string
      refresh_token?: string
      expires_in: number
      scope: string
    }>(
      await fetch(OAUTH.google.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(20_000),
      }),
      "Connecting Google"
    )
    const profile = await readJson<{ email?: string }>(
      await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(20_000),
      }),
      "Reading your Google account"
    )
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      scopes: token.scope.split(" ").filter(Boolean),
      account: profile.email ?? null,
    }
  }
  if (provider === "github")
    return exchangeGithub(code, redirectUri, clientId, clientSecret)
  if (provider === "meta") return exchangeMeta(code, redirectUri, clientId, clientSecret)
  const token = await readJson<{ access_token: string; workspace_name?: string }>(
    await fetch(OAUTH.notion.token, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(20_000),
    }),
    "Connecting Notion"
  )
  // Notion tokens don't expire
  return {
    accessToken: token.access_token,
    refreshToken: null,
    expiresAt: null,
    scopes: [],
    account: token.workspace_name ?? null,
  }
}

// GitHub answers a bad code with 200 and { error }, so the token is checked.
// Expiring user tokens aren't refreshed here (the refresh path is Google's):
// docs/kriya/deployment.md has the GitHub App keep them non-expiring, and an
// expired one asks the person to reconnect.
async function exchangeGithub(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<Tokens> {
  const token = await readJson<{
    access_token?: string
    expires_in?: number
    error_description?: string
  }>(
    await fetch(OAUTH.github.token, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(20_000),
    }),
    "Connecting GitHub"
  )
  if (!token.access_token) {
    throw new ConnectorError(
      `Connecting GitHub failed${token.error_description ? `: ${token.error_description.slice(0, 300)}` : ""}`
    )
  }
  const user = await readJson<{ login?: string }>(
    await fetch("https://api.github.com/user", {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(20_000),
    }),
    "Reading your GitHub account"
  )
  return {
    accessToken: token.access_token,
    refreshToken: null,
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
    scopes: [],
    account: user.login ?? null,
  }
}

// A short-lived Facebook Login token traded for a long-lived one (about 60
// days, no refresh token: the person reconnects after). The account is the
// first Instagram professional account linked to their Pages.
async function exchangeMeta(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<Tokens> {
  const tokenUrl = (params: Record<string, string>) =>
    `${OAUTH.meta.token}?${new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params })}`
  const short = await readJson<{ access_token: string }>(
    await fetch(tokenUrl({ code, redirect_uri: redirectUri }), {
      signal: AbortSignal.timeout(20_000),
    }),
    "Connecting Instagram"
  )
  const long = await readJson<{ access_token: string; expires_in?: number }>(
    await fetch(
      tokenUrl({
        grant_type: "fb_exchange_token",
        fb_exchange_token: short.access_token,
      }),
      { signal: AbortSignal.timeout(20_000) }
    ),
    "Connecting Instagram"
  )
  const auth = { Authorization: `Bearer ${long.access_token}` }
  const granted = await readJson<{ data?: { permission: string; status: string }[] }>(
    await fetch(`${META_GRAPH}/me/permissions`, {
      headers: auth,
      signal: AbortSignal.timeout(20_000),
    }),
    "Reading your Instagram permissions"
  )
  const pages = await readJson<{
    data?: { instagram_business_account?: { username?: string } }[]
  }>(
    await fetch(`${META_GRAPH}/me/accounts?fields=instagram_business_account{username}`, {
      headers: auth,
      signal: AbortSignal.timeout(20_000),
    }),
    "Reading your Instagram account"
  )
  const instagram = pages.data?.find((p) => p.instagram_business_account)
  if (!instagram) {
    throw new ConnectorError(
      "No Instagram professional account is linked to your Facebook Pages."
    )
  }
  return {
    accessToken: long.access_token,
    refreshToken: null,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
    scopes: (granted.data ?? [])
      .filter((p) => p.status === "granted")
      .map((p) => p.permission),
    account: instagram.instagram_business_account?.username ?? null,
  }
}

export const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}

/* ───────────────────────────── storage ──────────────────────────── */

// Ties each ciphertext to its owner and provider
const context = (userId: string, provider: ConnectionProvider) => `${userId}:${provider}`

// Written with the privileged connection: the person's session can't write
// this table. Callers have checked who the user is (session plus OAuth state).
export async function saveConnection(
  userId: string,
  provider: ConnectionProvider,
  tokens: Tokens
) {
  const ctx = context(userId, provider)
  const sealed = {
    account: tokens.account?.slice(0, 200) ?? null,
    scopes: tokens.scopes,
    accessToken: seal(tokens.accessToken, ctx),
    expiresAt: tokens.expiresAt,
  }
  // Google sends a refresh token only on consent; keep the old one otherwise
  const refresh = tokens.refreshToken
    ? { refreshToken: seal(tokens.refreshToken, ctx) }
    : {}
  await privileged
    .insert(connections)
    .values({ id: nanoid(12), userId, provider, ...sealed, ...refresh })
    .onConflictDoUpdate({
      target: [connections.userId, connections.provider],
      set: { ...sealed, ...refresh },
    })
}

// What a person has connected, without the tokens (read through RLS)
export async function listConnections(userId: string) {
  return withUser(userId, (tx) =>
    tx
      .select({
        provider: connections.provider,
        account: connections.account,
        scopes: connections.scopes,
        createdAt: connections.createdAt,
      })
      .from(connections)
  )
}

export type ConnectionSummary = Awaited<ReturnType<typeof listConnections>>[number]

const NAMES = {
  google: "Google",
  notion: "Notion",
  github: "GitHub",
  meta: "Instagram",
} as const
const reconnect = (provider: ConnectionProvider) =>
  `${NAMES[provider]} access has stopped working. Reconnect ${NAMES[provider]} in Account → Connected accounts.`

// A token that won't open (sealed with a retired key, or damaged) is a lost
// connection, not a crash: the person reconnects. A missing or malformed key
// is the platform's fault and stays an error (runbooks/key-rotation.md).
function openToken(sealed: string, userId: string, provider: ConnectionProvider) {
  try {
    return open(sealed, context(userId, provider))
  } catch (error) {
    if (error instanceof SecretsConfigError && !/retired/.test(error.message)) throw error
    throw new ConnectorError(reconnect(provider))
  }
}

// A working access token for the person's account, refreshed if it's about
// to expire. Only the worker calls this, always for the task's own user.
export async function accessToken(userId: string, provider: ConnectionProvider) {
  const [row] = await privileged
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
  if (!row) throw new ConnectorError(`${NAMES[provider]} isn't connected.`)
  const ctx = context(userId, provider)
  const fresh = !row.expiresAt || row.expiresAt.getTime() - Date.now() > 60_000
  if (fresh) return openToken(row.accessToken, userId, provider)
  if (!row.refreshToken) throw new ConnectorError(reconnect(provider))
  const refreshToken = openToken(row.refreshToken, userId, provider)

  const { clientId, clientSecret } = credentials(provider)
  const response = await fetch(OAUTH.google.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20_000),
  })
  // Revoked or expired consent
  if (response.status === 400 || response.status === 401) {
    throw new ConnectorError(reconnect(provider))
  }
  const token = await readJson<{ access_token: string; expires_in: number }>(
    response,
    "Refreshing Google access"
  )
  await privileged
    .update(connections)
    .set({
      accessToken: seal(token.access_token, ctx),
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      // During a key rotation the refresh token moves to the new key too
      ...(needsReseal(row.refreshToken) ? { refreshToken: seal(refreshToken, ctx) } : {}),
    })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
  return token.access_token
}

// Revokes Google's grant (Notion has no revoke API; the person removes Kriya
// in Notion's settings), then deletes the row through RLS. A token that won't
// open is skipped, not revoked: the row is still deleted.
export async function disconnect(userId: string, provider: ConnectionProvider) {
  if (provider === "google") {
    const [row] = await privileged
      .select({
        accessToken: connections.accessToken,
        refreshToken: connections.refreshToken,
      })
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
    const token = row && tryOpen(row.refreshToken ?? row.accessToken, userId, provider)
    if (token) {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {})
    }
  }
  if (provider === "github" || provider === "meta") {
    const [row] = await privileged
      .select({ accessToken: connections.accessToken })
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
    const token = row && tryOpen(row.accessToken, userId, provider)
    if (token) await revoke(provider, token).catch(() => {})
  }
  await withUser(userId, (tx) =>
    tx.delete(connections).where(eq(connections.provider, provider))
  )
}

function tryOpen(sealed: string, userId: string, provider: ConnectionProvider) {
  try {
    return openToken(sealed, userId, provider)
  } catch (error) {
    if (error instanceof ConnectorError) return null
    throw error
  }
}

// GitHub: the app's grant for this person; Meta: every permission Kriya has
async function revoke(provider: "github" | "meta", token: string) {
  if (provider === "github") {
    const { clientId, clientSecret } = credentials("github")
    await fetch(`https://api.github.com/applications/${clientId}/grant`, {
      method: "DELETE",
      headers: {
        ...GITHUB_HEADERS,
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(10_000),
    })
    return
  }
  await fetch(`${META_GRAPH}/me/permissions`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
}

/* ─────────────────────────────── calls ──────────────────────────── */

// For lib/connectors/*: an authorized request to the person's account. The
// token is opened here and never leaves this file (invariant 4); callers
// get the response, including empty ones (a DELETE answers 204).
export async function providerFetch(
  userId: string,
  provider: ConnectionProvider,
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
) {
  const token = await accessToken(userId, provider)
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(provider === "github" ? GITHUB_HEADERS : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  })
  if (response.status === 401) throw new ConnectorError(reconnect(provider))
  return response
}

// The JSON of a providerFetch answer, or a ConnectorError with the API's own
// message
export const jsonOf = <T>(response: Response, what: string) => readJson<T>(response, what)

// What an A8 write checked by reading its result back (TOOLS_AND_CONTRACTS §1)
export const readBack = (
  ok: boolean,
  evidence: Verification["evidence"],
  note: string
): Verification => ({
  status: ok ? "verified" : "failed",
  method: "api_readback",
  evidence,
  note,
})

const MAX_TEXT = 20_000

async function api<T>(
  userId: string,
  provider: ConnectionProvider,
  url: string,
  init: { method?: string; body?: unknown; raw?: boolean } = {}
): Promise<T> {
  const token = await accessToken(userId, provider)
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(provider === "notion" ? { "Notion-Version": "2022-06-28" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  })
  if (response.status === 401) throw new ConnectorError(reconnect(provider))
  if (init.raw) {
    if (!response.ok) {
      throw new ConnectorError(`The request failed (${response.status}).`)
    }
    return (await response.text()).slice(0, MAX_TEXT) as T
  }
  return readJson<T>(response, "The request")
}

const GOOGLE = "https://www.googleapis.com"

/* Calendar */

type GoogleEvent = {
  id: string
  summary?: string
  location?: string
  htmlLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { email: string }[]
}

const event = (e: GoogleEvent) => ({
  id: e.id,
  title: e.summary ?? "(no title)",
  start: e.start?.dateTime ?? e.start?.date ?? null,
  end: e.end?.dateTime ?? e.end?.date ?? null,
  location: e.location ?? null,
  attendees: e.attendees?.slice(0, 20).map((a) => a.email) ?? [],
  link: e.htmlLink ?? null,
})

export async function calendarEvents(
  userId: string,
  {
    from,
    to,
    query,
    limit,
  }: { from?: string; to?: string; query?: string; limit: number }
) {
  const url = new URL(`${GOOGLE}/calendar/v3/calendars/primary/events`)
  url.searchParams.set("singleEvents", "true")
  url.searchParams.set("orderBy", "startTime")
  url.searchParams.set("maxResults", String(limit))
  url.searchParams.set("timeMin", new Date(from ?? Date.now()).toISOString())
  if (to) url.searchParams.set("timeMax", new Date(to).toISOString())
  if (query) url.searchParams.set("q", query)
  const data = await api<{ items?: GoogleEvent[]; timeZone?: string }>(
    userId,
    "google",
    url.toString()
  )
  return { timeZone: data.timeZone ?? null, events: (data.items ?? []).map(event) }
}

// One event by id, as calendar_events lists it
export async function calendarEvent(userId: string, eventId: string) {
  return event(
    await api<GoogleEvent>(
      userId,
      "google",
      `${GOOGLE}/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`
    )
  )
}

export async function calendarCreate(
  userId: string,
  input: {
    title: string
    start: string
    end: string
    timeZone: string
    description?: string
    location?: string
    attendees?: string[]
  }
) {
  const url = new URL(`${GOOGLE}/calendar/v3/calendars/primary/events`)
  // Invites go out only when there are attendees, which the person approved
  url.searchParams.set("sendUpdates", input.attendees?.length ? "all" : "none")
  const created = await api<GoogleEvent>(userId, "google", url.toString(), {
    method: "POST",
    body: {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: input.start, timeZone: input.timeZone },
      end: { dateTime: input.end, timeZone: input.timeZone },
      attendees: input.attendees?.map((email) => ({ email })),
    },
  })
  // OF-13: read it back; confirmed only with this title and exactly these guests
  const check = await providerFetch(
    userId,
    "google",
    `${GOOGLE}/calendar/v3/calendars/primary/events/${encodeURIComponent(created.id)}`
  )
  const back = check.ok
    ? ((await check.json()) as GoogleEvent & { status?: string })
    : null
  const ok =
    back?.id === created.id &&
    back.status !== "cancelled" &&
    back.summary === input.title &&
    sameAddresses(back.attendees?.map((a) => a.email) ?? [], input.attendees ?? [])
  return {
    ...event(created),
    verification: readBack(
      ok,
      [
        { kind: "provider_id", value: created.id },
        ...(created.htmlLink ? [{ kind: "url" as const, value: created.htmlLink }] : []),
      ],
      "Read back from Google Calendar: the event is there with this title and these guests."
    ),
  }
}

// The same email addresses, ignoring case, order and display names
function sameAddresses(found: string[], wanted: string[]) {
  const norm = (list: string[]) =>
    [...new Set(list.map((a) => a.trim().toLowerCase()))].sort().join(",")
  return norm(found) === norm(wanted)
}
const addresses = (header: string | undefined) =>
  header?.match(/[^\s<>,"]+@[^\s<>,"]+/g) ?? []

// Undo (K3) and calendar_delete_event: deletes an event (Google sends
// attendees a cancellation when `notify`), then reads it back. True when it
// is gone: missing, or kept by Google as "cancelled".
export async function calendarDelete(userId: string, eventId: string, notify: boolean) {
  const url = `${GOOGLE}/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`
  const removed = await providerFetch(
    userId,
    "google",
    `${url}?sendUpdates=${notify ? "all" : "none"}`,
    { method: "DELETE" }
  )
  // 404 and 410: already deleted, which is what undo wants
  if (!removed.ok && removed.status !== 404 && removed.status !== 410) {
    throw new ConnectorError(`Deleting the event failed (${removed.status}).`)
  }
  const check = await providerFetch(userId, "google", url)
  if (check.status === 404 || check.status === 410) return true
  const after = await readJson<GoogleEvent & { status?: string }>(
    check,
    "Checking the event"
  )
  return after.status === "cancelled"
}

/* Gmail */

type GmailPart = {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
  headers?: { name: string; value: string }[]
}

const header = (part: GmailPart | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8")

// The plain-text body if there is one, else the HTML one
function bodyOf(part: GmailPart, html = false): string | null {
  const wanted = html ? "text/html" : "text/plain"
  if (part.mimeType === wanted && part.body?.data) return decode(part.body.data)
  for (const child of part.parts ?? []) {
    const found = bodyOf(child, html)
    if (found) return found
  }
  return null
}

const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

export async function gmailSearch(
  userId: string,
  { query, limit }: { query: string; limit: number }
) {
  const url = new URL(`${GOOGLE}/gmail/v1/users/me/messages`)
  url.searchParams.set("q", query)
  url.searchParams.set("maxResults", String(limit))
  const list = await api<{ messages?: { id: string }[] }>(
    userId,
    "google",
    url.toString()
  )
  const messages = await Promise.all(
    (list.messages ?? []).map(async ({ id }) => {
      const meta = new URL(`${GOOGLE}/gmail/v1/users/me/messages/${id}`)
      meta.searchParams.set("format", "metadata")
      for (const name of ["From", "To", "Subject", "Date"]) {
        meta.searchParams.append("metadataHeaders", name)
      }
      const m = await api<{ id: string; snippet?: string; payload?: GmailPart }>(
        userId,
        "google",
        meta.toString()
      )
      return {
        id: m.id,
        from: header(m.payload, "From"),
        to: header(m.payload, "To"),
        subject: header(m.payload, "Subject"),
        date: header(m.payload, "Date"),
        snippet: m.snippet ?? "",
      }
    })
  )
  return { query, messages }
}

export async function gmailRead(userId: string, id: string) {
  const m = await api<{ id: string; payload?: GmailPart }>(
    userId,
    "google",
    `${GOOGLE}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`
  )
  const text = m.payload ? bodyOf(m.payload) : null
  const html = !text && m.payload ? bodyOf(m.payload, true) : null
  return {
    id: m.id,
    from: header(m.payload, "From"),
    to: header(m.payload, "To"),
    subject: header(m.payload, "Subject"),
    date: header(m.payload, "Date"),
    body: (text ?? (html ? stripHtml(html) : "")).slice(0, MAX_TEXT),
    // For file_save_attachment (A5); names and sizes only, never the bytes
    attachments: (m.payload ? attachmentsOf(m.payload) : []).map((p) => ({
      attachmentId: p.body!.attachmentId!,
      name: p.filename!,
      mime: p.mimeType ?? null,
      sizeBytes: p.body?.size ?? null,
    })),
  }
}

const attachmentsOf = (part: GmailPart): GmailPart[] => [
  ...(part.filename && part.body?.attachmentId ? [part] : []),
  ...(part.parts ?? []).flatMap(attachmentsOf),
]

// One attachment's bytes for file_save_attachment (A5). Its name and type
// come from the message itself, and it's refused before downloading when
// the type isn't one Kriya files accept or it's too large.
export async function gmailAttachment(
  userId: string,
  messageId: string,
  attachmentId: string
) {
  const messageUrl = `${GOOGLE}/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`
  const m = await api<{ payload?: GmailPart }>(
    userId,
    "google",
    `${messageUrl}?format=full`
  )
  const part = (m.payload ? attachmentsOf(m.payload) : []).find(
    (p) => p.body?.attachmentId === attachmentId
  )
  if (!part)
    throw new ConnectorError(
      "That email has no attachment with that id. Read it again with gmail_read and use an id from its attachments."
    )
  const name = part.filename!
  const mime = part.mimeType ?? ""
  if (!IMPORTABLE.has(mime))
    throw new ConnectorError(
      `${name} is a ${mime || "unknown"} file, which can't be saved. PDFs, Word files, images and text can.`
    )
  const tooBig = () =>
    new ConnectorError(
      `${name} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB, the most Kriya saves.`
    )
  if ((part.body?.size ?? 0) > MAX_IMPORT_BYTES) throw tooBig()
  const { data } = await api<{ data?: string }>(
    userId,
    "google",
    `${messageUrl}/attachments/${encodeURIComponent(attachmentId)}`
  )
  const bytes = Buffer.from(data ?? "", "base64url")
  if (bytes.length > MAX_IMPORT_BYTES) throw tooBig()
  return { name, mime, bytes }
}

// Headers can't carry line breaks (header injection); non-ASCII subjects are
// encoded per RFC 2047
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim()
const encodedSubject = (subject: string) =>
  /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`

export function draftMime(input: {
  to: string[]
  cc?: string[]
  subject: string
  body: string
}) {
  return [
    `To: ${oneLine(input.to.join(", "))}`,
    ...(input.cc?.length ? [`Cc: ${oneLine(input.cc.join(", "))}`] : []),
    `Subject: ${encodedSubject(oneLine(input.subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    input.body,
  ].join("\r\n")
}

export async function gmailDraft(
  userId: string,
  input: { to: string[]; cc?: string[]; subject: string; body: string }
) {
  const draft = await api<{ id: string }>(
    userId,
    "google",
    `${GOOGLE}/gmail/v1/users/me/drafts`,
    {
      method: "POST",
      body: {
        message: { raw: Buffer.from(draftMime(input), "utf8").toString("base64url") },
      },
    }
  )
  const link = "https://mail.google.com/mail/u/0/#drafts"
  // OF-13: read back its headers only (never the body); confirmed when the
  // draft exists with exactly these recipients
  const check = await providerFetch(
    userId,
    "google",
    `${GOOGLE}/gmail/v1/users/me/drafts/${encodeURIComponent(draft.id)}?format=metadata&metadataHeaders=To&metadataHeaders=Cc`
  )
  const back = check.ok
    ? ((await check.json()) as {
        id?: string
        message?: { payload?: { headers?: { name: string; value: string }[] } }
      })
    : null
  const headers = back?.message?.payload?.headers ?? []
  const value = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
  const ok =
    back?.id === draft.id &&
    sameAddresses(addresses(value("To")), input.to) &&
    sameAddresses(addresses(value("Cc")), input.cc ?? [])
  return {
    draftId: draft.id,
    link,
    verification: readBack(
      ok,
      [
        { kind: "provider_id", value: draft.id },
        { kind: "url", value: link },
      ],
      "Read back from Gmail: the draft is saved with these recipients."
    ),
  }
}

// Undo (K3): deletes a draft Kriya saved, then reads it back. True when gone.
export async function gmailDeleteDraft(userId: string, draftId: string) {
  const url = `${GOOGLE}/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`
  const removed = await providerFetch(userId, "google", url, { method: "DELETE" })
  if (!removed.ok && removed.status !== 404) {
    throw new ConnectorError(`Deleting the draft failed (${removed.status}).`)
  }
  return (await providerFetch(userId, "google", url)).status === 404
}

/* Drive */

type DriveFile = {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
}

export async function driveSearch(
  userId: string,
  { query, limit }: { query: string; limit: number }
) {
  const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  const url = new URL(`${GOOGLE}/drive/v3/files`)
  url.searchParams.set("q", `fullText contains '${escaped}' and trashed = false`)
  url.searchParams.set("pageSize", String(limit))
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink)")
  const data = await api<{ files?: DriveFile[] }>(userId, "google", url.toString())
  return { query, files: data.files ?? [] }
}

const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
}

export async function driveRead(userId: string, id: string) {
  const fileUrl = `${GOOGLE}/drive/v3/files/${encodeURIComponent(id)}`
  const file = await api<DriveFile>(
    userId,
    "google",
    `${fileUrl}?fields=id,name,mimeType,modifiedTime,webViewLink`
  )
  const exportAs = EXPORTS[file.mimeType]
  const readable =
    file.mimeType.startsWith("text/") ||
    ["application/json", "application/xml"].includes(file.mimeType)
  if (!exportAs && !readable) {
    throw new ConnectorError(
      `${file.name} is a ${file.mimeType} file, which can't be read yet. Google Docs, Sheets, Slides and text files can.`
    )
  }
  const text = await api<string>(
    userId,
    "google",
    exportAs
      ? `${fileUrl}/export?mimeType=${encodeURIComponent(exportAs)}`
      : `${fileUrl}?alt=media`,
    { raw: true }
  )
  return { ...file, text }
}

/* Drive: import and share (G2, GOOGLE_CONNECTIVITY §4.1) */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
// The types Kriya files accept (lib/files.ts); Google's own files come as PDF
const IMPORTABLE = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "text/plain",
  DOCX,
])
const AS_PDF = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.spreadsheet",
])
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024

// A Drive file's bytes for drive_import; refused before downloading when
// its type isn't accepted or it's too large. The plan's own limits apply
// when it's saved.
export async function driveDownload(userId: string, id: string) {
  const fileUrl = `${GOOGLE}/drive/v3/files/${encodeURIComponent(id)}`
  const file = await api<DriveFile & { size?: string }>(
    userId,
    "google",
    `${fileUrl}?fields=id,name,mimeType,size`
  )
  const asPdf = AS_PDF.has(file.mimeType)
  if (!asPdf && !IMPORTABLE.has(file.mimeType)) {
    throw new ConnectorError(
      `${file.name} is a ${file.mimeType} file, which can't be imported. PDFs, Word files, images, text, and Google Docs, Sheets and Slides (as PDF) can.`
    )
  }
  const tooBig = () =>
    new ConnectorError(
      `${file.name} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB, the most Kriya imports.`
    )
  if (Number(file.size ?? 0) > MAX_IMPORT_BYTES) throw tooBig()
  const response = await providerFetch(
    userId,
    "google",
    asPdf
      ? `${fileUrl}/export?mimeType=${encodeURIComponent("application/pdf")}`
      : `${fileUrl}?alt=media`
  )
  if (!response.ok) {
    throw new ConnectorError(`Downloading ${file.name} failed (${response.status}).`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_IMPORT_BYTES) throw tooBig()
  return {
    id: file.id,
    name: asPdf && !/\.pdf$/i.test(file.name) ? `${file.name}.pdf` : file.name,
    mime: asPdf ? "application/pdf" : file.mimeType,
    bytes,
  }
}

type Permission = { id: string; emailAddress?: string; role?: string }

const permissionsOf = async (userId: string, fileUrl: string) =>
  (
    await api<{ permissions?: Permission[] }>(
      userId,
      "google",
      `${fileUrl}/permissions?fields=permissions(id,emailAddress,role)`
    )
  ).permissions ?? []

// Gives each address access to a file (Google emails them), then reads the
// permissions back. If one fails part-way, what was added is still returned,
// so undo can take it away again.
export async function driveShare(
  userId: string,
  input: { fileId: string; emails: string[]; role: "reader" | "commenter" }
) {
  const fileUrl = `${GOOGLE}/drive/v3/files/${encodeURIComponent(input.fileId)}`
  const permissionIds: string[] = []
  let failure: string | null = null
  for (const emailAddress of input.emails) {
    try {
      const added = await api<{ id: string }>(
        userId,
        "google",
        `${fileUrl}/permissions?sendNotificationEmail=true&fields=id`,
        { method: "POST", body: { type: "user", role: input.role, emailAddress } }
      )
      permissionIds.push(added.id)
    } catch (error) {
      if (permissionIds.length === 0) throw error
      failure = error instanceof Error ? error.message : "Sharing failed part-way."
      break
    }
  }
  const found = await permissionsOf(userId, fileUrl)
  const file = await api<{ name?: string; webViewLink?: string }>(
    userId,
    "google",
    `${fileUrl}?fields=name,webViewLink`
  )
  const ok =
    !failure &&
    input.emails.every((email) =>
      found.some(
        (p) =>
          permissionIds.includes(p.id) &&
          p.role === input.role &&
          p.emailAddress?.toLowerCase() === email.toLowerCase()
      )
    )
  return {
    fileId: input.fileId,
    name: file.name ?? null,
    link: file.webViewLink ?? null,
    role: input.role,
    emails: input.emails,
    permissionIds,
    verification: readBack(
      ok,
      [
        { kind: "provider_id", value: input.fileId },
        ...(file.webViewLink ? [{ kind: "url" as const, value: file.webViewLink }] : []),
      ],
      failure
        ? `Only ${permissionIds.length} of ${input.emails.length} were added: ${failure}`
        : "Read back from Drive: these people now have access."
    ),
  }
}

// Undo (K3): removes exactly the permissions drive_share added, then reads
// them back. True when none of them is left.
export async function driveUnshare(
  userId: string,
  fileId: string,
  permissionIds: string[]
) {
  const fileUrl = `${GOOGLE}/drive/v3/files/${encodeURIComponent(fileId)}`
  for (const id of permissionIds) {
    const removed = await providerFetch(
      userId,
      "google",
      `${fileUrl}/permissions/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    )
    if (!removed.ok && removed.status !== 404) {
      throw new ConnectorError(`Removing access failed (${removed.status}).`)
    }
  }
  const left = await permissionsOf(userId, fileUrl)
  return !left.some((p) => permissionIds.includes(p.id))
}

/* Gmail: send a reviewed draft (G2, OD-16) */

// Sends a draft as it is, then checks the message is in Sent. A sent
// email can't be taken back, so there is no undo.
export async function gmailSendDraft(userId: string, draftId: string) {
  const sent = await api<{ id: string; threadId?: string }>(
    userId,
    "google",
    `${GOOGLE}/gmail/v1/users/me/drafts/send`,
    { method: "POST", body: { id: draftId } }
  )
  const check = await providerFetch(
    userId,
    "google",
    `${GOOGLE}/gmail/v1/users/me/messages/${encodeURIComponent(sent.id)}?format=minimal`
  )
  const back = check.ok
    ? ((await check.json()) as { id?: string; labelIds?: string[] })
    : null
  const ok = back?.id === sent.id && Boolean(back.labelIds?.includes("SENT"))
  return {
    messageId: sent.id,
    verification: readBack(
      ok,
      [{ kind: "provider_id", value: sent.id }],
      "Read back from Gmail: the message is in Sent."
    ),
  }
}

/* Notion */

type RichText = { plain_text?: string }[]
type NotionObject = {
  id: string
  object: "page" | "database"
  url?: string
  last_edited_time?: string
  title?: RichText
  properties?: Record<string, { type: string; title?: RichText }>
}

const plain = (rich: RichText | undefined) =>
  rich?.map((t) => t.plain_text ?? "").join("") ?? ""

function notionTitle(item: NotionObject) {
  if (item.object === "database") return plain(item.title)
  const title = Object.values(item.properties ?? {}).find((p) => p.type === "title")
  return plain(title?.title)
}

export async function notionSearch(
  userId: string,
  { query, limit }: { query: string; limit: number }
) {
  const data = await api<{ results?: NotionObject[] }>(
    userId,
    "notion",
    "https://api.notion.com/v1/search",
    { method: "POST", body: { query, page_size: limit } }
  )
  return {
    query,
    results: (data.results ?? []).map((item) => ({
      id: item.id,
      type: item.object,
      title: notionTitle(item) || "Untitled",
      url: item.url ?? null,
      edited: item.last_edited_time ?? null,
    })),
  }
}

const PREFIX: Record<string, string> = {
  heading_1: "# ",
  heading_2: "## ",
  heading_3: "### ",
  bulleted_list_item: "- ",
  numbered_list_item: "1. ",
  quote: "> ",
}

// ponytail: first 100 top-level blocks only; follow `has_children` and
// `next_cursor` if long or nested pages turn out to matter
export async function notionRead(userId: string, id: string) {
  type Block = { type: string } & Record<
    string,
    { rich_text?: RichText; checked?: boolean } | string
  >
  const data = await api<{ results?: Block[] }>(
    userId,
    "notion",
    `https://api.notion.com/v1/blocks/${encodeURIComponent(id)}/children?page_size=100`
  )
  const lines = (data.results ?? []).flatMap((block) => {
    const content = block[block.type]
    if (typeof content !== "object") return []
    const text = plain(content.rich_text)
    if (!text) return []
    const prefix =
      block.type === "to_do"
        ? content.checked
          ? "[x] "
          : "[ ] "
        : (PREFIX[block.type] ?? "")
    return [prefix + text]
  })
  return { id, text: lines.join("\n").slice(0, MAX_TEXT) }
}
