// Adapted from DeepSeek Harness @ ce7073d51254c26cd63b22a60835b8f948deb447 (MIT, NOTICE.md):
// fs/tool-fs-search (limits only)

import fs from "node:fs/promises"
import path from "node:path"

import { killGroup, spawnAs } from "./exec"
import { ensureRepo, gitEnv, gitOk, GIT_FLAGS } from "./git"
import { resolve, type Ctx } from "./paths"
import { RunnerError, type ListRequest, type SearchRequest } from "./protocol"

// P7 through `git grep` (the workspace is always a repository): it honours
// .gitignore, skips binary files and needs no extra binary in the image
export async function search(ctx: Ctx, request: SearchRequest) {
  await ensureRepo(ctx)
  const base = await resolve(ctx, request.path)
  const prefix = base.rel === "." ? "" : `${base.rel}/`
  const pathspec = request.glob
    ? [`:(glob)${prefix}${request.glob.includes("/") ? "" : "**/"}${request.glob}`]
    : prefix
      ? [prefix]
      : []
  const { searchMatches, searchLineChars, searchSeconds } = ctx.limits
  const args = [
    ...GIT_FLAGS,
    "grep",
    "-z",
    "-n",
    "-I",
    "--no-color",
    "--untracked",
    "--exclude-standard",
    request.fixed ? "-F" : "-E",
    "-e",
    request.pattern,
    "--",
    ...pathspec,
  ]
  return new Promise<{
    matches: { path: string; line: number; text: string }[]
    truncated: boolean
  }>((done, fail) => {
    const child = spawnAs(ctx, "git", args, { env: gitEnv(ctx) })
    child.stdin.end()
    const matches: { path: string; line: number; text: string }[] = []
    let truncated = false
    let pending = ""
    let stderr = ""
    const stop = () => {
      truncated = true
      killGroup(child, ctx.killGraceMs)
    }
    const timer = setTimeout(stop, searchSeconds * 1000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return
      pending += chunk
      let newline
      while ((newline = pending.indexOf("\n")) >= 0) {
        const [file, line, ...rest] = pending.slice(0, newline).split("\0")
        pending = pending.slice(newline + 1)
        if (matches.length === searchMatches) return stop()
        const text = rest.join("\0")
        matches.push({
          path: file,
          line: Number(line),
          text:
            text.length > searchLineChars ? `${text.slice(0, searchLineChars)}…` : text,
        })
      }
    })
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.on("error", fail)
    child.on("close", (code) => {
      clearTimeout(timer)
      // 1: no match; 128 and up: git refused the pattern or path
      if (!truncated && code !== 0 && code !== 1) {
        return fail(new RunnerError(400, `search failed: ${stderr.trim().slice(0, 200)}`))
      }
      done({ matches, truncated })
    })
  })
}

// Files git would see (ignored ones left out) and the folders above them
export async function list(ctx: Ctx, request: ListRequest) {
  await ensureRepo(ctx)
  const base = await resolve(ctx, request.path)
  const depth = request.depth ?? 2
  const output = await gitOk(ctx, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
  const prefix = base.rel === "." ? "" : `${base.rel}/`
  const entries = new Map<
    string,
    { path: string; type: "file" | "dir" | "symlink"; bytes: number }
  >()
  for (const file of new Set(output.split("\0").filter(Boolean))) {
    if (!file.startsWith(prefix)) continue
    const parts = file.slice(prefix.length).split("/")
    for (let d = 1; d < parts.length && d <= depth; d++) {
      const dir = prefix + parts.slice(0, d).join("/")
      entries.set(dir, { path: dir, type: "dir", bytes: 0 })
    }
    if (parts.length > depth) continue
    // A tracked file deleted from the tree isn't listed
    const stat = await fs.lstat(path.join(ctx.root, file)).catch(() => null)
    if (!stat) continue
    entries.set(file, {
      path: file,
      type: stat.isSymbolicLink() ? "symlink" : "file",
      bytes: stat.size,
    })
  }
  const sorted = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
  return {
    entries: sorted.slice(0, ctx.limits.listEntries),
    truncated: sorted.length > ctx.limits.listEntries,
  }
}
