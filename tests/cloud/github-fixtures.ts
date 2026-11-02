import { randomBytes } from "node:crypto"

import { vi } from "vitest"

import { saveConnection } from "@/lib/connectors"

// GitHub answered from fixtures, for import and publish (C5). Unlike
// tests/connectors/fixtures.ts this passes every other request through, so
// the in-process runner on 127.0.0.1 keeps working, and a body may be bytes
// (the tarball). Bodies follow GitHub's documented shapes with synthetic
// names and ids; no live call was made.

export type GhFixture = {
  method?: string
  url: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}
export type GhCall = {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

export const GH_TOKEN = "test-token-github"
const GITHUB = /^https:\/\/([a-z]+\.)?github\.com\//

export function serveGithub(fixtures: GhFixture[]) {
  const calls: GhCall[] = []
  const queue = [...fixtures]
  const real = globalThis.fetch
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!GITHUB.test(url)) return real(input, init)
      const method = init?.method ?? "GET"
      let body: unknown = init?.body ?? null
      if (typeof body === "string") {
        try {
          body = JSON.parse(body)
        } catch {}
      }
      calls.push({
        method,
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
      })
      const i = queue.findIndex((f) => (f.method ?? "GET") === method && f.url.test(url))
      if (i < 0) throw new Error(`No GitHub fixture for ${method} ${url}`)
      const [f] = queue.splice(i, 1)
      const bytes = Buffer.isBuffer(f.body)
      return new Response(
        f.body === undefined
          ? null
          : bytes
            ? new Uint8Array(f.body as Buffer)
            : JSON.stringify(f.body),
        {
          status: f.status ?? 200,
          headers: {
            "content-type": bytes ? "application/x-gzip" : "application/json",
            ...f.headers,
          },
        }
      )
    })
  )
  return { calls, left: () => queue.length }
}

// The person's GitHub connection, sealed as in production
export async function connectGithub(userId: string) {
  process.env.KRIYA_TOKEN_KEY ??= randomBytes(32).toString("base64")
  await saveConnection(userId, "github", {
    accessToken: GH_TOKEN,
    refreshToken: null,
    expiresAt: null,
    scopes: [],
    account: "test-account",
  })
}

const API = "https://api.github.com"
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
export const at = (path: string) => new RegExp(`^${esc(API + path)}(\\?|$)`)

export const BASE = "b".repeat(40)

// The import of a repository's default branch at BASE: the tarball request
// is redirected to a download host, as GitHub documents
export const importFixtures = (repo: string, tarball: Buffer): GhFixture[] => [
  { url: at(`/repos/${repo}`), body: { default_branch: "main" } },
  { url: at(`/repos/${repo}/commits/main`), body: { sha: BASE } },
  {
    url: at(`/repos/${repo}/tarball/${BASE}`),
    status: 302,
    headers: {
      location: `https://codeload.github.com/${repo}/legacy.tar.gz/${BASE}?token=short`,
    },
  },
  {
    url: /^https:\/\/codeload\.github\.com\//,
    body: tarball,
    headers: { "content-length": String(tarball.length) },
  },
]

// One tree commit on BASE, a new branch, a draft pull request and its read-back
export const publishFixtures = (
  repo: string,
  branch: string,
  options: { draft?: boolean; blobs?: number } = {}
): GhFixture[] => [
  { url: at(`/repos/${repo}`), body: { default_branch: "main" } },
  {
    url: at(`/repos/${repo}/git/ref/heads/${branch}`),
    status: 404,
    body: { message: "Not Found" },
  },
  {
    url: at(`/repos/${repo}/git/commits/${BASE}`),
    body: { sha: BASE, tree: { sha: "t".repeat(40) } },
  },
  ...Array.from({ length: options.blobs ?? 1 }, (_, n) => ({
    method: "POST",
    url: at(`/repos/${repo}/git/blobs`),
    status: 201,
    body: { sha: `${n}`.repeat(40).slice(0, 40) },
  })),
  {
    method: "POST",
    url: at(`/repos/${repo}/git/trees`),
    status: 201,
    body: { sha: "e".repeat(40) },
  },
  {
    method: "POST",
    url: at(`/repos/${repo}/git/commits`),
    status: 201,
    body: { sha: "c".repeat(40) },
  },
  {
    method: "POST",
    url: at(`/repos/${repo}/git/refs`),
    status: 201,
    body: { ref: `refs/heads/${branch}` },
  },
  {
    method: "POST",
    url: at(`/repos/${repo}/pulls`),
    status: 201,
    body: {
      number: 12,
      html_url: `https://github.com/${repo}/pull/12`,
      title: "t",
      state: "open",
    },
  },
  {
    url: at(`/repos/${repo}/pulls/12`),
    body: {
      number: 12,
      html_url: `https://github.com/${repo}/pull/12`,
      title: "t",
      state: "open",
      draft: options.draft ?? true,
      head: { ref: branch, sha: "c".repeat(40) },
      base: { ref: "main" },
    },
  },
]
