import fs from "node:fs/promises"
import path from "node:path"

import { RunnerError, type Limits } from "./protocol"

// One runner serves one workspace for one generation (one sandbox's life)
export type Ctx = {
  // realpath of /workspace
  root: string
  limits: Limits
  generation: number
  // The `kriya` user when the runner runs as root (the image); unset in tests
  runAs?: { uid: number; gid: number }
  // CD-12: the in-image egress proxy, when the runner runs as root
  proxyUrl?: string
  home: string
  path: string
  killGraceMs: number
  // P4: what this runner last saw of each file (null = it didn't exist)
  seen: Map<string, Observation | null>
}

export type Observation = { size: number; mtimeMs: number; sha256: string }

// The runner's own area: logs. Readable, never writable through the API
export const OWN_DIR = ".kriya"

const inside = (root: string, abs: string) =>
  abs === root || abs.startsWith(root + path.sep)

// Resolves a request path inside the workspace. Refuses absolute paths, any
// `..`, anything whose nearest existing ancestor (symlinks followed) is
// outside, and, for writes, the runner's own area.
export async function resolve(ctx: Ctx, rel: string | undefined, write = false) {
  const value = rel ?? "."
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new RunnerError(403, `${value}: use a path inside the workspace, without ..`)
  }
  const abs = path.resolve(ctx.root, value)
  const relative = path.relative(ctx.root, abs)
  if (write && (relative === "" || relative.split(path.sep)[0] === OWN_DIR)) {
    throw new RunnerError(403, `${value}: this path can't be written`)
  }
  let probe = abs
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      if (!inside(ctx.root, real)) {
        throw new RunnerError(403, `${value}: this path leads outside the workspace`)
      }
      break
    } catch (error) {
      if (error instanceof RunnerError) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      probe = path.dirname(probe)
    }
  }
  return { abs, rel: relative.split(path.sep).join("/") || "." }
}

// Files and folders the runner (root in the image) creates belong to `kriya`
export async function own(ctx: Ctx, abs: string) {
  if (ctx.runAs) await fs.lchown(abs, ctx.runAs.uid, ctx.runAs.gid)
}

export async function mkdirOwned(ctx: Ctx, dir: string) {
  const missing: string[] = []
  for (let d = dir; d !== ctx.root && inside(ctx.root, d); d = path.dirname(d)) {
    const exists = await fs.stat(d).then(
      () => true,
      () => false
    )
    if (exists) break
    missing.unshift(d)
  }
  for (const d of missing) {
    await fs.mkdir(d)
    await own(ctx, d)
  }
}
