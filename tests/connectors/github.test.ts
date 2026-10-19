import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import {
  BRANCH,
  FILE_PATH,
  githubCloseIssue,
  githubComment,
  githubCreateIssue,
  githubDeleteComment,
  githubLabel,
  githubOpenPr,
  githubReadIssue,
  githubRemoveLabels,
  githubSearch,
  REPO as REPO_PATTERN,
} from "@/lib/connectors/github"

import { connectedUser, REPO, serve, TOKEN } from "./fixtures"

// GitHub (A8): parsing, error mapping, read-back verification, and the
// token only ever in the Authorization header (invariant 4).

const API = "https://api.github.com"
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
const at = (path: string) => new RegExp(`^${esc(API + path)}(\\?|$)`)

let userId: string
beforeAll(async () => {
  ;({ userId } = await connectedUser(["github"]))
})
afterEach(() => vi.unstubAllGlobals())

describe("reads", () => {
  it("parses search results and sends the token only as a bearer header", async () => {
    const calls = serve([
      {
        url: at("/search/issues"),
        body: {
          total_count: 1,
          items: [
            {
              number: 7,
              title: "Dark mode",
              state: "open",
              html_url: `https://github.com/${REPO}/issues/7`,
              repository_url: `${API}/repos/${REPO}`,
              pull_request: { url: "x" },
              updated_at: "2026-10-01T00:00:00Z",
            },
          ],
        },
      },
    ])
    const result = await githubSearch(userId, { query: `repo:${REPO} is:open`, limit: 5 })
    expect(result.results).toEqual([
      expect.objectContaining({ repo: REPO, number: 7, kind: "pull_request" }),
    ])
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN("github")}`)
    expect(calls[0].headers["x-github-api-version"]).toBe("2022-11-28")
    expect(calls[0].url).not.toContain(TOKEN("github"))
  })

  it("maps a 404 to the app-not-installed message", async () => {
    serve([
      { url: at(`/repos/${REPO}/issues/1`), status: 404, body: { message: "Not Found" } },
    ])
    await expect(githubReadIssue(userId, { repo: REPO, number: 1 })).rejects.toThrow(
      /isn't installed on that repository/
    )
  })

  it("maps a 401 to reconnect", async () => {
    serve([{ url: at("/search/issues"), status: 401, body: {} }])
    await expect(githubSearch(userId, { query: "x", limit: 1 })).rejects.toThrow(
      /Reconnect GitHub/
    )
  })

  it("rejects repository names and paths that could leave the repository", () => {
    expect(REPO_PATTERN.test(REPO)).toBe(true)
    expect(REPO_PATTERN.test("octo-org/../admin")).toBe(false)
    expect(REPO_PATTERN.test("octo-org/x/y")).toBe(false)
    expect(BRANCH.test("kriya/fix-typo")).toBe(true)
    expect(BRANCH.test("a..b")).toBe(false)
    expect(FILE_PATH.test("docs/README.md")).toBe(true)
    expect(FILE_PATH.test("../secrets")).toBe(false)
    expect(FILE_PATH.test("/etc/passwd")).toBe(false)
  })
})

describe("writes read back what they made", () => {
  it("a comment is verified when GitHub returns the same text", async () => {
    const calls = serve([
      {
        method: "POST",
        url: at(`/repos/${REPO}/issues/7/comments`),
        status: 201,
        body: {
          id: 9001,
          html_url: `https://github.com/${REPO}/issues/7#issuecomment-9001`,
        },
      },
      {
        url: at(`/repos/${REPO}/issues/comments/9001`),
        body: { id: 9001, body: "Thanks!" },
      },
    ])
    const result = await githubComment(userId, { repo: REPO, number: 7, body: "Thanks!" })
    expect(calls[0].body).toEqual({ body: "Thanks!" })
    expect(result.commentId).toBe(9001)
    expect(result.verification).toMatchObject({
      status: "verified",
      method: "api_readback",
    })
  })

  it("a comment whose read-back differs is failed, not verified", async () => {
    serve([
      {
        method: "POST",
        url: at(`/repos/${REPO}/issues/7/comments`),
        status: 201,
        body: { id: 9002, html_url: "https://github.com/x" },
      },
      {
        url: at(`/repos/${REPO}/issues/comments/9002`),
        body: { id: 9002, body: "other" },
      },
    ])
    const result = await githubComment(userId, { repo: REPO, number: 7, body: "Thanks!" })
    expect(result.verification.status).toBe("failed")
  })

  it("an issue is verified open with its title", async () => {
    serve([
      {
        method: "POST",
        url: at(`/repos/${REPO}/issues`),
        status: 201,
        body: {
          number: 12,
          title: "Bug",
          state: "open",
          html_url: "https://github.com/i/12",
        },
      },
      {
        url: at(`/repos/${REPO}/issues/12`),
        body: {
          number: 12,
          title: "Bug",
          state: "open",
          html_url: "https://github.com/i/12",
        },
      },
    ])
    const result = await githubCreateIssue(userId, { repo: REPO, title: "Bug" })
    expect(result).toMatchObject({ number: 12, verification: { status: "verified" } })
  })

  it("labels record only what this call added", async () => {
    const path = `/repos/${REPO}/issues/7/labels`
    serve([
      { url: at(path), body: [{ name: "bug" }] },
      { method: "POST", url: at(path), body: [{ name: "bug" }, { name: "ui" }] },
      { url: at(path), body: [{ name: "bug" }, { name: "ui" }] },
    ])
    const result = await githubLabel(userId, {
      repo: REPO,
      number: 7,
      labels: ["bug", "ui"],
    })
    expect(result.added).toEqual(["ui"])
    expect(result.verification.status).toBe("verified")
  })

  it("a pull request: branch from base, file written with its sha, PR read back", async () => {
    const calls = serve([
      { url: at(`/repos/${REPO}`), body: { default_branch: "main" } },
      {
        url: at(`/repos/${REPO}/git/ref/heads/main`),
        body: { object: { sha: "abc123" } },
      },
      { method: "POST", url: at(`/repos/${REPO}/git/refs`), status: 201, body: {} },
      { url: at(`/repos/${REPO}/contents/docs/README.md`), body: { sha: "file-sha" } },
      { method: "PUT", url: at(`/repos/${REPO}/contents/docs/README.md`), body: {} },
      {
        method: "POST",
        url: at(`/repos/${REPO}/pulls`),
        status: 201,
        body: {
          number: 3,
          title: "Fix typo",
          state: "open",
          html_url: "https://github.com/p/3",
        },
      },
      {
        url: at(`/repos/${REPO}/pulls/3`),
        body: {
          number: 3,
          title: "Fix typo",
          state: "open",
          html_url: "https://github.com/p/3",
          head: { ref: "kriya/fix-typo" },
          base: { ref: "main" },
        },
      },
    ])
    const result = await githubOpenPr(userId, {
      repo: REPO,
      branch: "kriya/fix-typo",
      title: "Fix typo",
      files: [{ path: "docs/README.md", content: "Hello" }],
    })
    expect(calls[2].body).toEqual({ ref: "refs/heads/kriya/fix-typo", sha: "abc123" })
    expect(calls[4].body).toMatchObject({
      branch: "kriya/fix-typo",
      sha: "file-sha",
      content: Buffer.from("Hello").toString("base64"),
    })
    expect(result).toMatchObject({
      number: 3,
      base: "main",
      verification: { status: "verified" },
    })
  })
})

describe("undo compensations (K3)", () => {
  it("a deleted comment is confirmed gone by a 404 read-back", async () => {
    serve([
      { method: "DELETE", url: at(`/repos/${REPO}/issues/comments/9001`), status: 204 },
      { url: at(`/repos/${REPO}/issues/comments/9001`), status: 404, body: {} },
    ])
    expect(await githubDeleteComment(userId, REPO, 9001)).toBe(true)
  })

  it("a comment still there after the delete is not reported as gone", async () => {
    serve([
      { method: "DELETE", url: at(`/repos/${REPO}/issues/comments/9001`), status: 204 },
      { url: at(`/repos/${REPO}/issues/comments/9001`), body: { id: 9001 } },
    ])
    expect(await githubDeleteComment(userId, REPO, 9001)).toBe(false)
  })

  it("removes only the given labels and checks they are gone", async () => {
    const path = `/repos/${REPO}/issues/7/labels`
    const calls = serve([
      { method: "DELETE", url: at(`${path}/ui`), body: [] },
      { url: at(path), body: [{ name: "bug" }] },
    ])
    expect(await githubRemoveLabels(userId, REPO, 7, ["ui"])).toBe(true)
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1)
  })

  it("closes an issue as not planned", async () => {
    const calls = serve([
      { method: "PATCH", url: at(`/repos/${REPO}/issues/12`), body: {} },
      {
        url: at(`/repos/${REPO}/issues/12`),
        body: { number: 12, title: "Bug", state: "closed" },
      },
    ])
    expect(await githubCloseIssue(userId, REPO, 12)).toBe(true)
    expect(calls[0].body).toEqual({ state: "closed", state_reason: "not_planned" })
  })
})
