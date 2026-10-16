import { and, eq } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, withUser } from "@/db"
import { connections, type ConnectionProvider } from "@/db/schema"
import { getSecret } from "@/lib/config"
import { isSecretsConfigured, open, seal } from "@/lib/secrets"

// Connected accounts: OAuth with Google and Notion, the tokens (sealed with
// lib/secrets.ts, refreshed here), and the API calls agents make through the
// tools in lib/agent/tools.ts. Used by the web server for connecting and by
// the worker for tool calls, so nothing here depends on Next.js.

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

export type GoogleService = keyof typeof GOOGLE_SERVICES

export function isGoogleService(value: string): value is GoogleService {
  return value in GOOGLE_SERVICES
}

// The Google services a set of granted scopes switches on
export function googleServices(scopes: string[]) {
  return (Object.keys(GOOGLE_SERVICES) as GoogleService[]).filter((service) =>
    GOOGLE_SERVICES[service].scopes.every((scope) => scopes.includes(scope))
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
} as const

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
    const scopes = [
      "openid",
      "email",
      ...services.flatMap((s) => GOOGLE_SERVICES[s].scopes),
    ]
    url.searchParams.set("scope", scopes.join(" "))
    // A refresh token, so agents can work while the person is away
    url.searchParams.set("access_type", "offline")
    url.searchParams.set("prompt", "consent")
  } else {
    url.searchParams.set("owner", "user")
  }
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

const NAMES = { google: "Google", notion: "Notion" } as const
const reconnect = (provider: ConnectionProvider) =>
  `${NAMES[provider]} access has stopped working. Reconnect ${NAMES[provider]} in Account → Connected accounts.`

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
  if (fresh) return open(row.accessToken, ctx)
  if (!row.refreshToken) throw new ConnectorError(reconnect(provider))

  const { clientId, clientSecret } = credentials(provider)
  const response = await fetch(OAUTH.google.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: open(row.refreshToken, ctx),
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
    })
    .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
  return token.access_token
}

// Revokes Google's grant (Notion has no revoke API; the person removes Kriya
// in Notion's settings), then deletes the row through RLS
export async function disconnect(userId: string, provider: ConnectionProvider) {
  if (provider === "google") {
    const [row] = await privileged
      .select({
        accessToken: connections.accessToken,
        refreshToken: connections.refreshToken,
      })
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, provider)))
    if (row) {
      const token = open(row.refreshToken ?? row.accessToken, context(userId, provider))
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {})
    }
  }
  await withUser(userId, (tx) =>
    tx.delete(connections).where(eq(connections.provider, provider))
  )
}

/* ─────────────────────────────── calls ──────────────────────────── */

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
  return event(created)
}

/* Gmail */

type GmailPart = {
  mimeType?: string
  body?: { data?: string }
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
  }
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
  return { draftId: draft.id, link: "https://mail.google.com/mail/u/0/#drafts" }
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
