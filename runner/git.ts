import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { childEnv, spawnAs } from "./exec"
import { OWN_DIR, type Ctx } from "./paths"
import { RunnerError } from "./protocol"

// git as the workspace user, with no global or system config and no hooks,
// so nothing a repository carries runs with the runner's rights
export function gitEnv(ctx: Ctx, extra: Record<string, string> = {}) {
  return {
    ...childEnv(ctx),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  }
}

export const GIT_FLAGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "user.name=Kriya",
  "-c",
  "user.email=runner@kriya.invalid",
]

export async function git(
  ctx: Ctx,
  args: string[],
  options: { input?: Buffer; env?: Record<string, string>; maxBytes?: number } = {}
) {
  return new Promise<{
    code: number | null
    stdout: Buffer
    stderr: string
    overflow: boolean
  }>((done, fail) => {
    const child = spawnAs(ctx, "git", [...GIT_FLAGS, ...args], {
      env: gitEnv(ctx, options.env),
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        if (!overflow) child.kill("SIGKILL")
        overflow = true
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8")
    })
    child.on("error", fail)
    child.on("close", (code) =>
      done({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim(), overflow })
    )
    child.stdin.on("error", () => {})
    child.stdin.end(options.input)
  })
}

// A git call that must succeed
export async function gitOk(ctx: Ctx, args: string[], env?: Record<string, string>) {
  const result = await git(ctx, args, { env })
  if (result.code !== 0) {
    throw new RunnerError(500, `git ${args[0]} failed: ${result.stderr.slice(0, 300)}`)
  }
  return result.stdout.toString("utf8")
}

export const hasRepo = (ctx: Ctx) =>
  fs.stat(path.join(ctx.root, ".git")).then(
    () => true,
    () => false
  )

// git init with the runner's area ignored and one base commit. A blank
// workspace gets an empty base the first time anything needs git
export async function initRepo(ctx: Ctx, message: string, addAll: boolean) {
  await gitOk(ctx, ["init", "-q", "-b", "main"])
  await fs.appendFile(path.join(ctx.root, ".git", "info", "exclude"), `/${OWN_DIR}/\n`)
  if (addAll) await gitOk(ctx, ["add", "-A"])
  await gitOk(ctx, ["commit", "-q", "--allow-empty", "--no-verify", "-m", message])
  return (await gitOk(ctx, ["rev-parse", "HEAD"])).trim()
}

const repos = new WeakMap<Ctx, Promise<unknown>>()

export function ensureRepo(ctx: Ctx) {
  let pending = repos.get(ctx)
  if (!pending) {
    pending = hasRepo(ctx).then((exists) =>
      exists ? undefined : initRepo(ctx, "Blank workspace", false)
    )
    repos.set(ctx, pending)
  }
  return pending
}

// Import claims the repository for this generation before it writes anything
export function claimRepo(ctx: Ctx, work: Promise<unknown>) {
  repos.set(ctx, work)
}

export const repoClaimed = (ctx: Ctx) => repos.has(ctx)

// The working tree as git would commit it (untracked included, ignored
// left out) in a throwaway index, so the person's own index is never touched
export async function withSnapshot<T>(
  ctx: Ctx,
  work: (env: Record<string, string>) => Promise<T>
) {
  await ensureRepo(ctx)
  const index = path.join(ctx.root, ".git", `kriya-index-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    await gitOk(ctx, ["read-tree", "HEAD"], env)
    await gitOk(ctx, ["add", "-A"], env)
    return await work(env)
  } finally {
    await fs.rm(index, { force: true })
  }
}
