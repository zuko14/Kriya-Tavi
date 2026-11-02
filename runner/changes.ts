// Adapted from DeepSeek Harness @ ce7073d51254c26cd63b22a60835b8f948deb447 (MIT, NOTICE.md):
// deliverables/workspace-changes (the idea; no code taken)

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { ensureRepo, git, gitOk, withSnapshot } from "./git"
import type { Ctx } from "./paths"
import {
  RunnerError,
  type ChangedFile,
  type Changes,
  type ChangeSetFile,
  type ChangeStatus,
} from "./protocol"

type Entry = ChangedFile & { mode: ChangeSetFile["mode"]; blob: string }

const STATUS: Record<string, ChangeStatus> = { A: "added", D: "deleted" }
const MODES = new Set(["100644", "100755", "120000"])

// Changed files against the base commit, from the snapshot index
async function entries(ctx: Ctx, env: Record<string, string>) {
  const diff = ["diff", "--cached", "--no-renames", "-z"]
  const raw = (await gitOk(ctx, [...diff, "--raw", "HEAD"], env)).split("\0")
  const numstat = (await gitOk(ctx, [...diff, "--numstat", "HEAD"], env)).split("\0")
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (const record of numstat) {
    const [added, removed, file] = record.split("\t")
    if (file === undefined) continue
    const binary = added === "-"
    counts.set(file, {
      added: binary ? 0 : Number(added),
      removed: binary ? 0 : Number(removed),
      binary,
    })
  }
  const out: Entry[] = []
  // :oldmode newmode oldblob newblob status \0 path \0
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, , newBlob, letter] = raw[i].slice(1).split(" ")
    const file = raw[i + 1]
    const status = STATUS[letter] ?? "modified"
    const mode = (status === "deleted" ? oldMode : newMode) as Entry["mode"]
    if (!MODES.has(mode)) continue
    const stat = status === "deleted" ? null : await fs.lstat(path.join(ctx.root, file))
    out.push({
      path: file,
      status,
      mode,
      blob: newBlob,
      bytes: stat?.size ?? 0,
      ...(counts.get(file) ?? { added: 0, removed: 0, binary: false }),
    })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

// Stable for the same content and modes; changes with any byte
const changeSetId = (files: Entry[]) =>
  createHash("sha256")
    .update(files.map((f) => `${f.path}\0${f.status}\0${f.mode}\0${f.blob}`).join("\n"))
    .digest("hex")

export async function changes(ctx: Ctx, maxDiffBytes?: number): Promise<Changes> {
  return withSnapshot(ctx, async (env) => {
    const files = await entries(ctx, env)
    const limit = Math.min(maxDiffBytes ?? ctx.limits.diffBytes, ctx.limits.diffBytes)
    const diff = await git(ctx, ["diff", "--cached", "--no-renames", "HEAD"], {
      env,
      maxBytes: limit,
    })
    return {
      changeSetId: changeSetId(files),
      files: files.map((f) => ({
        path: f.path,
        status: f.status,
        added: f.added,
        removed: f.removed,
        binary: f.binary,
        bytes: f.bytes,
      })),
      diff: diff.stdout.toString("utf8"),
      truncated: diff.overflow,
    }
  })
}

// Contents for publishing, read from the blobs the id was computed from
export async function changeSetFiles(ctx: Ctx, id: string) {
  return withSnapshot(ctx, async (env) => {
    const files = await entries(ctx, env)
    if (changeSetId(files) !== id) {
      throw new RunnerError(
        409,
        "the workspace changed since that change set: list the changes again"
      )
    }
    const out: ChangeSetFile[] = []
    for (const file of files) {
      const entry: ChangeSetFile = {
        path: file.path,
        status: file.status,
        mode: file.mode,
      }
      if (file.status !== "deleted") {
        const blob = await git(ctx, ["cat-file", "blob", file.blob])
        entry.contentBase64 = blob.stdout.toString("base64")
      }
      out.push(entry)
    }
    return { files: out }
  })
}

// A binary patch base → working tree (untracked included, ignored left out)
export async function checkpoint(ctx: Ctx) {
  return withSnapshot(ctx, async (env) => {
    const files = await entries(ctx, env)
    const result = await git(
      ctx,
      ["diff", "--cached", "--binary", "--no-renames", "HEAD"],
      {
        env,
        maxBytes: ctx.limits.checkpointBytes,
      }
    )
    if (result.overflow) {
      const mb = Math.floor(ctx.limits.checkpointBytes / (1024 * 1024))
      throw new RunnerError(
        413,
        `the checkpoint is larger than ${mb ? `${mb} MB` : `${ctx.limits.checkpointBytes} bytes`}; remove large generated files or add them to .gitignore`
      )
    }
    if (result.code !== 0) throw new RunnerError(500, `git diff failed: ${result.stderr}`)
    return {
      patch: result.stdout,
      sha256: createHash("sha256").update(result.stdout).digest("hex"),
      changes: {
        files: files.length,
        added: files.reduce((n, f) => n + f.added, 0),
        removed: files.reduce((n, f) => n + f.removed, 0),
      },
    }
  })
}

// git apply is all or nothing: on failure the tree stays at base
export async function restore(ctx: Ctx, patch: Buffer) {
  await ensureRepo(ctx)
  if (!patch.length) return { applied: true as const }
  const result = await git(ctx, ["apply", "--binary", "--whitespace=nowarn", "-"], {
    input: patch,
  })
  if (result.code !== 0) {
    throw new RunnerError(
      422,
      `the checkpoint doesn't apply to this workspace's base; the tree is unchanged (${result.stderr.slice(0, 200)})`
    )
  }
  return { applied: true as const }
}
