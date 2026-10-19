import { ConnectorError, jsonOf, providerFetch, readBack } from "@/lib/connectors"

// GitHub through its REST API (AD-07), as the person, with the GitHub App
// they installed on the repositories they chose. Reads are R0; every write
// is R4 (lib/agent/policy.ts) and reads back what it made.

const API = "https://api.github.com"

// owner/name, checked before it goes into a URL
export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
export const BRANCH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,100}(?<![/.])$/
export const FILE_PATH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/ -]{1,300}$/

const BODY_MAX = 8_000
const COMMENT_MAX = 2_000

const fail = (status: number) => {
  if (status === 404)
    return "Not found on GitHub, or Kriya's GitHub app isn't installed on that repository."
  if (status === 403 || status === 429)
    return `GitHub refused this (${status}): no access to that repository, or the rate limit was reached.`
  return null
}

async function gh<T>(
  userId: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await providerFetch(userId, "github", `${API}${path}`, init)
  const known = fail(response.status)
  if (known) throw new ConnectorError(known)
  return jsonOf<T>(response, "The GitHub request")
}

// A read whose 404 is an answer, not an error (read-backs, existing files)
async function status(userId: string, path: string) {
  return providerFetch(userId, "github", `${API}${path}`)
}

type User = { login?: string } | null
type Issue = {
  number: number
  title: string
  state: string
  body?: string | null
  user?: User
  html_url: string
  labels?: ({ name?: string } | string)[]
  pull_request?: unknown
  repository_url?: string
  updated_at?: string
}

const labelNames = (labels: Issue["labels"]) =>
  (labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")))

/* ───────────────────────────── reads ────────────────────────────── */

// No notifications tool: GitHub's notifications endpoints accept only classic
// personal access tokens, never a GitHub App's user token (docs.github.com,
// read 2026-10-18)

export async function githubSearch(
  userId: string,
  { query, limit }: { query: string; limit: number }
) {
  const data = await gh<{ total_count: number; items: Issue[] }>(
    userId,
    `/search/issues?${new URLSearchParams({ q: query, per_page: String(limit) })}`
  )
  return {
    query,
    total: data.total_count,
    results: data.items.map((i) => ({
      repo: i.repository_url?.replace(`${API}/repos/`, "") ?? null,
      number: i.number,
      title: i.title,
      state: i.state,
      kind: i.pull_request ? "pull_request" : "issue",
      url: i.html_url,
      updated: i.updated_at ?? null,
    })),
  }
}

export async function githubReadIssue(
  userId: string,
  { repo, number }: { repo: string; number: number }
) {
  const issue = await gh<Issue>(userId, `/repos/${repo}/issues/${number}`)
  const comments = await gh<{ user?: User; body?: string; created_at: string }[]>(
    userId,
    `/repos/${repo}/issues/${number}/comments?per_page=30`
  )
  return {
    repo,
    number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ?? null,
    labels: labelNames(issue.labels),
    url: issue.html_url,
    body: (issue.body ?? "").slice(0, BODY_MAX),
    comments: comments.map((c) => ({
      author: c.user?.login ?? null,
      at: c.created_at,
      body: (c.body ?? "").slice(0, COMMENT_MAX),
    })),
  }
}

export async function githubReadPr(
  userId: string,
  { repo, number }: { repo: string; number: number }
) {
  const pr = await gh<
    Issue & { merged?: boolean; head: { ref: string }; base: { ref: string } }
  >(userId, `/repos/${repo}/pulls/${number}`)
  const files = await gh<
    { filename: string; status: string; additions: number; deletions: number }[]
  >(userId, `/repos/${repo}/pulls/${number}/files?per_page=50`)
  return {
    repo,
    number,
    title: pr.title,
    state: pr.state,
    merged: pr.merged ?? false,
    author: pr.user?.login ?? null,
    head: pr.head.ref,
    base: pr.base.ref,
    url: pr.html_url,
    body: (pr.body ?? "").slice(0, BODY_MAX),
    files: files.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
  }
}

/* ───────────────────────────── writes ───────────────────────────── */

export async function githubComment(
  userId: string,
  { repo, number, body }: { repo: string; number: number; body: string }
) {
  const created = await gh<{ id: number; html_url: string }>(
    userId,
    `/repos/${repo}/issues/${number}/comments`,
    { method: "POST", body: { body } }
  )
  const back = await gh<{ body?: string }>(
    userId,
    `/repos/${repo}/issues/comments/${created.id}`
  )
  return {
    repo,
    number,
    commentId: created.id,
    url: created.html_url,
    verification: readBack(
      back.body === body,
      [
        { kind: "url", value: created.html_url },
        { kind: "provider_id", value: String(created.id) },
      ],
      "Read back from GitHub: the comment exists with this text."
    ),
  }
}

export async function githubCreateIssue(
  userId: string,
  { repo, title, body }: { repo: string; title: string; body?: string }
) {
  const created = await gh<Issue>(userId, `/repos/${repo}/issues`, {
    method: "POST",
    body: { title, body },
  })
  const back = await gh<Issue>(userId, `/repos/${repo}/issues/${created.number}`)
  return {
    repo,
    number: created.number,
    url: created.html_url,
    verification: readBack(
      back.title === title && back.state === "open",
      [
        { kind: "url", value: created.html_url },
        { kind: "provider_id", value: `${repo}#${created.number}` },
      ],
      "Read back from GitHub: the issue is open with this title."
    ),
  }
}

// Only the labels this call added are recorded, so Undo never removes one
// that was already there
export async function githubLabel(
  userId: string,
  { repo, number, labels }: { repo: string; number: number; labels: string[] }
) {
  const path = `/repos/${repo}/issues/${number}/labels`
  const before = labelNames(await gh<Issue["labels"]>(userId, path))
  await gh(userId, path, { method: "POST", body: { labels } })
  const after = labelNames(await gh<Issue["labels"]>(userId, path))
  const issue = `https://github.com/${repo}/issues/${number}`
  return {
    repo,
    number,
    added: labels.filter((l) => !before.includes(l)),
    labels: after,
    verification: readBack(
      labels.every((l) => after.includes(l)),
      [{ kind: "url", value: issue }],
      "Read back from GitHub: the issue carries these labels."
    ),
  }
}

const contentPath = (path: string) => path.split("/").map(encodeURIComponent).join("/")

// A new branch from base with small text files written through the contents
// API, then the pull request. ponytail: one commit per file; a Git tree
// commit if multi-file PRs need to be atomic.
export async function githubOpenPr(
  userId: string,
  input: {
    repo: string
    base?: string
    branch: string
    title: string
    body?: string
    files: { path: string; content: string }[]
  }
) {
  const { repo, branch, title } = input
  const base =
    input.base ??
    (await gh<{ default_branch: string }>(userId, `/repos/${repo}`)).default_branch
  const ref = await gh<{ object: { sha: string } }>(
    userId,
    `/repos/${repo}/git/ref/heads/${base}`
  )
  await gh(userId, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: ref.object.sha },
  })
  for (const file of input.files) {
    const path = `/repos/${repo}/contents/${contentPath(file.path)}`
    const existing = await status(userId, `${path}?ref=${encodeURIComponent(branch)}`)
    const sha =
      existing.status === 404
        ? undefined
        : (await jsonOf<{ sha: string }>(existing, "Reading the file")).sha
    await gh(userId, path, {
      method: "PUT",
      body: {
        message: title,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch,
        ...(sha && { sha }),
      },
    })
  }
  const pr = await gh<Issue>(userId, `/repos/${repo}/pulls`, {
    method: "POST",
    body: { title, body: input.body, head: branch, base },
  })
  const back = await gh<Issue & { head: { ref: string }; base: { ref: string } }>(
    userId,
    `/repos/${repo}/pulls/${pr.number}`
  )
  return {
    repo,
    number: pr.number,
    url: pr.html_url,
    branch,
    base,
    verification: readBack(
      back.state === "open" && back.head.ref === branch && back.base.ref === base,
      [
        { kind: "url", value: pr.html_url },
        { kind: "provider_id", value: `${repo}#${pr.number}` },
      ],
      `Read back from GitHub: the pull request from ${branch} into ${base} is open.`
    ),
  }
}

/* ─────────────────────── undo (K3) compensations ────────────────── */

// Each returns true when a read-back shows the change is reversed

export async function githubDeleteComment(userId: string, repo: string, id: number) {
  const path = `/repos/${repo}/issues/comments/${id}`
  const removed = await providerFetch(userId, "github", `${API}${path}`, {
    method: "DELETE",
  })
  if (!removed.ok && removed.status !== 404) {
    throw new ConnectorError(`Deleting the comment failed (${removed.status}).`)
  }
  return (await status(userId, path)).status === 404
}

export async function githubRemoveLabels(
  userId: string,
  repo: string,
  number: number,
  labels: string[]
) {
  const path = `/repos/${repo}/issues/${number}/labels`
  for (const label of labels) {
    const removed = await providerFetch(
      userId,
      "github",
      `${API}${path}/${encodeURIComponent(label)}`,
      { method: "DELETE" }
    )
    if (!removed.ok && removed.status !== 404) {
      throw new ConnectorError(`Removing the label failed (${removed.status}).`)
    }
  }
  const after = labelNames(await gh<Issue["labels"]>(userId, path))
  return labels.every((l) => !after.includes(l))
}

// Most people can't delete an issue, so Undo closes it as not planned
export async function githubCloseIssue(userId: string, repo: string, number: number) {
  const path = `/repos/${repo}/issues/${number}`
  await gh(userId, path, {
    method: "PATCH",
    body: { state: "closed", state_reason: "not_planned" },
  })
  return (await gh<Issue>(userId, path)).state === "closed"
}
