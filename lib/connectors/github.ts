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
  // A read that can't be done leaves the issue unverified, not failed (N3)
  const back = await gh<Issue>(userId, `/repos/${repo}/issues/${created.number}`).catch(
    () => null
  )
  return {
    repo,
    number: created.number,
    url: created.html_url,
    verification: readBack(
      back === null ? null : back.title === title && back.state === "open",
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

/* ─────────────────── cloud workspaces (track C) ─────────────────── */

// Additive (C5, CD-09, CD-10; owner go-ahead 2026-10-31): a repository at
// one commit into a workspace, and one tree commit on a new kriya/ branch
// with a draft pull request out of it. Nothing here updates, merges or
// deletes an existing ref.

const SHA = /^[0-9a-f]{40}$/
export const KRIYA_BRANCH = /^kriya\/[a-z0-9._-]{1,60}$/
const PUBLISH_FILES = 300
const PUBLISH_FILE_BYTES = 5 * 1024 * 1024
const PUBLISH_BYTES = 50 * 1024 * 1024

// The repository at one commit as a gzip tar stream. ref null is the
// default branch; the returned ref is the branch it resolved to.
// shortcut: the download rides providerFetch's 30 s timeout once fetch
// follows GitHub's redirect; give the download its own timeout if large
// repositories fail there (checked on the owner's test repository, CB-04)
export async function githubTarball(userId: string, repo: string, ref: string | null) {
  if (!REPO.test(repo)) throw new ConnectorError("That isn't a GitHub repository name.")
  const name =
    ref ?? (await gh<{ default_branch: string }>(userId, `/repos/${repo}`)).default_branch
  if (!BRANCH.test(name) && !SHA.test(name)) {
    throw new ConnectorError("That isn't a branch, tag or commit name.")
  }
  const commit = await gh<{ sha: string }>(userId, `/repos/${repo}/commits/${name}`)
  let response = await providerFetch(
    userId,
    "github",
    `${API}/repos/${repo}/tarball/${commit.sha}`
  )
  // A redirect fetch didn't follow: follow it to GitHub's download host
  // without the person's token
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(response.headers.get("location") ?? "", API)
    if (location.protocol !== "https:" || !/(^|\.)github\.com$/.test(location.hostname)) {
      throw new ConnectorError("GitHub sent the download somewhere unexpected.")
    }
    response = await fetch(location, { signal: AbortSignal.timeout(300_000) })
  }
  const known = fail(response.status)
  if (known) throw new ConnectorError(known)
  if (!response.ok || !response.body) {
    throw new ConnectorError(`Downloading the repository failed (${response.status}).`)
  }
  const length = Number(response.headers.get("content-length"))
  return {
    sha: commit.sha,
    ref: name,
    body: response.body,
    bytes: Number.isFinite(length) && length > 0 ? length : null,
  }
}

// A path GitHub will place inside the repository, never in .git
const treePath = (path: string) =>
  path.length > 0 &&
  path.length <= 1000 &&
  !path.startsWith("/") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  path.split("/")[0] !== ".git"

// One commit with these files on top of baseSha (blobs, a tree, a commit),
// then a new branch pointing at it. Creating a ref that exists fails at
// GitHub, so nothing is ever moved. Limits are checked before any request.
export async function githubCommitTree(
  userId: string,
  input: {
    repo: string
    // The branch the pull request will go into
    base: string
    baseSha: string
    branch: string
    message: string
    // content null deletes the path
    files: {
      path: string
      mode: "100644" | "100755" | "120000"
      content: Buffer | null
    }[]
  }
) {
  const { repo, base, baseSha, branch, files } = input
  if (!REPO.test(repo)) throw new ConnectorError("That isn't a GitHub repository name.")
  if (!KRIYA_BRANCH.test(branch) || !BRANCH.test(branch)) {
    throw new ConnectorError(
      "A new branch must start with kriya/ and use lowercase letters, digits, dots, dashes or underscores."
    )
  }
  if (!BRANCH.test(base) || branch === base) {
    throw new ConnectorError("The branch must be new, not the base branch.")
  }
  if (!SHA.test(baseSha)) throw new ConnectorError("The base commit isn't a commit sha.")
  if (files.length === 0) throw new ConnectorError("There are no changes to publish.")
  if (files.length > PUBLISH_FILES) {
    throw new ConnectorError(`A publish carries at most ${PUBLISH_FILES} files.`)
  }
  let total = 0
  for (const file of files) {
    if (!treePath(file.path))
      throw new ConnectorError(`${file.path}: not a path in the repository.`)
    const size = file.content?.length ?? 0
    if (size > PUBLISH_FILE_BYTES)
      throw new ConnectorError(`${file.path} is larger than 5 MB.`)
    total += size
  }
  if (total > PUBLISH_BYTES)
    throw new ConnectorError("The changes are larger than 50 MB.")

  const { default_branch } = await gh<{ default_branch: string }>(
    userId,
    `/repos/${repo}`
  )
  if (branch === default_branch) {
    throw new ConnectorError("The branch can't be the repository's default branch.")
  }
  const existing = await status(userId, `/repos/${repo}/git/ref/heads/${branch}`)
  if (existing.status !== 404) {
    throw new ConnectorError(
      `The branch ${branch} already exists on GitHub; choose a new name.`
    )
  }
  const baseCommit = await gh<{ tree: { sha: string } }>(
    userId,
    `/repos/${repo}/git/commits/${baseSha}`
  )
  const tree: { path: string; mode: string; type: "blob"; sha: string | null }[] = []
  for (const file of files) {
    if (file.content === null) {
      tree.push({ path: file.path, mode: file.mode, type: "blob", sha: null })
      continue
    }
    const blob = await gh<{ sha: string }>(userId, `/repos/${repo}/git/blobs`, {
      method: "POST",
      body: { content: file.content.toString("base64"), encoding: "base64" },
    })
    tree.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha })
  }
  const newTree = await gh<{ sha: string }>(userId, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: baseCommit.tree.sha, tree },
  })
  const commit = await gh<{ sha: string }>(userId, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: { message: input.message, tree: newTree.sha, parents: [baseSha] },
  })
  await gh(userId, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  })
  return { commitSha: commit.sha, branch }
}

// A draft pull request from the new branch, read back: open, a draft, at
// the commit just made, into the base
export async function githubOpenDraftPr(
  userId: string,
  input: {
    repo: string
    branch: string
    base: string
    title: string
    body?: string
    commitSha: string
  }
) {
  const { repo, branch, base, commitSha } = input
  const pr = await gh<Issue>(userId, `/repos/${repo}/pulls`, {
    method: "POST",
    body: { title: input.title, body: input.body, head: branch, base, draft: true },
  })
  // A read that can't be done leaves it unverified, not failed (N3)
  const back = await gh<
    Issue & { draft?: boolean; head: { ref: string; sha: string }; base: { ref: string } }
  >(userId, `/repos/${repo}/pulls/${pr.number}`).catch(() => null)
  return {
    repo,
    number: pr.number,
    url: pr.html_url,
    branch,
    base,
    verification: readBack(
      back === null
        ? null
        : back.state === "open" &&
            back.draft === true &&
            back.head.ref === branch &&
            back.head.sha === commitSha &&
            back.base.ref === base,
      [
        { kind: "url", value: pr.html_url },
        { kind: "provider_id", value: `${repo}#${pr.number}` },
      ],
      `Read back from GitHub: a draft pull request from ${branch} at ${commitSha.slice(0, 7)} into ${base} is open.`
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
