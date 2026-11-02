import { gunzipSync } from "node:zlib"

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import {
  githubCommitTree,
  githubOpenDraftPr,
  githubTarball,
} from "@/lib/connectors/github"

import { cloudDb } from "./db"
import {
  at,
  BASE,
  connectGithub,
  GH_TOKEN,
  importFixtures,
  publishFixtures,
  serveGithub,
} from "./github-fixtures"
import { FIXTURE } from "./fake-provider"
import { packDirectory } from "./tar"

// The three additive GitHub functions of track C (CD-09, CD-10; owner
// go-ahead 2026-10-31): a repository at one commit in, one tree commit on a
// new kriya/ branch and a draft pull request out. Never an existing ref.

const REPO = "owner/calc"
let userId: string

beforeAll(async () => {
  userId = (await cloudDb()).user
  await connectGithub(userId)
})
afterEach(() => vi.unstubAllGlobals())

const read = async (body: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(body).arrayBuffer())

describe("githubTarball", () => {
  it("resolves the default branch to a commit and follows the download without the token", async () => {
    const tarball = packDirectory(FIXTURE)
    const { calls } = serveGithub(importFixtures(REPO, tarball))
    const archive = await githubTarball(userId, REPO, null)
    expect(archive).toMatchObject({ sha: BASE, ref: "main", bytes: tarball.length })
    expect(
      gunzipSync(await read(archive.body as ReadableStream<Uint8Array>)).length
    ).toBeGreaterThan(0)
    const download = calls.find((c) => c.url.startsWith("https://codeload.github.com/"))!
    expect(download.headers.authorization).toBeUndefined()
    for (const c of calls) expect(c.url).not.toContain(GH_TOKEN)
    expect(calls[0].headers.authorization).toBe(`Bearer ${GH_TOKEN}`)
  })

  it("takes a branch as given and refuses names that could leave the repository", async () => {
    serveGithub([
      { url: at(`/repos/${REPO}/commits/release/1.2`), body: { sha: BASE } },
      { url: at(`/repos/${REPO}/tarball/${BASE}`), body: Buffer.from("x") },
    ])
    expect((await githubTarball(userId, REPO, "release/1.2")).ref).toBe("release/1.2")
    await expect(githubTarball(userId, "../etc", null)).rejects.toThrow()
    await expect(githubTarball(userId, REPO, "../../x")).rejects.toThrow()
  })
})

describe("githubCommitTree (CT-PUB-01, -03, -05)", () => {
  const files = [
    {
      path: "src/math.js",
      mode: "100644" as const,
      content: Buffer.from("export const x = 1\n"),
    },
    { path: "src/old.js", mode: "100644" as const, content: null },
  ]
  const input = (over: Partial<Parameters<typeof githubCommitTree>[1]> = {}) => ({
    repo: REPO,
    base: "main",
    baseSha: BASE,
    branch: "kriya/fix-multiply",
    message: "Fix multiply",
    files,
    ...over,
  })

  it("blobs, one tree on the base commit, one commit, a new ref; deletions as null entries", async () => {
    const { calls, left } = serveGithub(
      publishFixtures(REPO, "kriya/fix-multiply").slice(0, 7)
    )
    const result = await githubCommitTree(userId, input())
    expect(result).toEqual({ commitSha: "c".repeat(40), branch: "kriya/fix-multiply" })
    expect(left()).toBe(0)
    const tree = calls.find((c) => c.url.endsWith("/git/trees"))!.body as {
      base_tree: string
      tree: { path: string; sha: string | null }[]
    }
    expect(tree.base_tree).toBe("t".repeat(40))
    expect(tree.tree).toEqual([
      { path: "src/math.js", mode: "100644", type: "blob", sha: "0".repeat(40) },
      { path: "src/old.js", mode: "100644", type: "blob", sha: null },
    ])
    expect(calls.find((c) => c.url.endsWith("/git/commits"))!.body).toEqual({
      message: "Fix multiply",
      tree: "e".repeat(40),
      parents: [BASE],
    })
    expect(calls.find((c) => c.url.endsWith("/git/refs"))!.body).toEqual({
      ref: "refs/heads/kriya/fix-multiply",
      sha: "c".repeat(40),
    })
    // Never moves a ref: no PATCH, no force, no update of an existing branch
    expect(calls.filter((c) => c.method === "PATCH" || c.method === "DELETE")).toEqual([])
  })

  it("refuses an existing branch, a branch outside kriya/ and the default branch", async () => {
    const { calls } = serveGithub([
      { url: at(`/repos/${REPO}`), body: { default_branch: "main" } },
      {
        url: at(`/repos/${REPO}/git/ref/heads/kriya/taken`),
        body: { ref: "refs/heads/kriya/taken" },
      },
    ])
    await expect(
      githubCommitTree(userId, input({ branch: "kriya/taken" }))
    ).rejects.toThrow(/already exists/)
    for (const branch of ["main", "feature/x", "kriya/", "kriya/UPPER", "kriya/a..b"]) {
      await expect(githubCommitTree(userId, input({ branch })), branch).rejects.toThrow(
        /kriya\//
      )
    }
    serveGithub([{ url: at(`/repos/${REPO}`), body: { default_branch: "kriya/main" } }])
    await expect(
      githubCommitTree(userId, input({ branch: "kriya/main" }))
    ).rejects.toThrow(/default branch/)
    expect(calls.filter((c) => c.method !== "GET")).toEqual([])
  })

  it("refuses limits and bad paths before any request", async () => {
    const { calls } = serveGithub([])
    const many = Array.from({ length: 301 }, (_, n) => ({
      path: `f${n}.txt`,
      mode: "100644" as const,
      content: Buffer.from("x"),
    }))
    const big = [
      {
        path: "big.bin",
        mode: "100644" as const,
        content: Buffer.alloc(5 * 1024 * 1024 + 1),
      },
    ]
    const total = Array.from({ length: 11 }, (_, n) => ({
      path: `p${n}.bin`,
      mode: "100644" as const,
      content: Buffer.alloc(5 * 1024 * 1024),
    }))
    for (const bad of [
      many,
      big,
      total,
      [],
      [{ path: "../x", mode: "100644" as const, content: Buffer.from("x") }],
      [{ path: ".git/config", mode: "100644" as const, content: Buffer.from("x") }],
      [{ path: "/abs", mode: "100644" as const, content: Buffer.from("x") }],
    ]) {
      await expect(githubCommitTree(userId, input({ files: bad }))).rejects.toThrow()
    }
    await expect(githubCommitTree(userId, input({ baseSha: "nope" }))).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe("githubOpenDraftPr", () => {
  const pr = {
    repo: REPO,
    branch: "kriya/fix-multiply",
    base: "main",
    title: "Fix multiply",
    body: "Changed one line.",
    commitSha: "c".repeat(40),
  }

  it("opens a draft and reads it back", async () => {
    const { calls } = serveGithub(publishFixtures(REPO, "kriya/fix-multiply").slice(7))
    const result = await githubOpenDraftPr(userId, pr)
    expect(result).toMatchObject({
      repo: REPO,
      number: 12,
      url: `https://github.com/${REPO}/pull/12`,
      branch: "kriya/fix-multiply",
      base: "main",
      verification: { status: "verified", method: "api_readback" },
    })
    expect(calls[0].body).toEqual({
      title: "Fix multiply",
      body: "Changed one line.",
      head: "kriya/fix-multiply",
      base: "main",
      draft: true,
    })
  })

  it("a read-back that disagrees (not a draft) is failed, not verified", async () => {
    serveGithub(publishFixtures(REPO, "kriya/fix-multiply", { draft: false }).slice(7))
    expect((await githubOpenDraftPr(userId, pr)).verification.status).toBe("failed")
  })
})
