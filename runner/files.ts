// Adapted from DeepSeek Harness @ ce7073d51254c26cd63b22a60835b8f948deb447 (MIT, NOTICE.md):
// fs/fs-observation-policy, fs/tool-str-replace-editor (exact-replace semantics)

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { applyHunks, parsePatch, PatchError } from "./patch"
import { mkdirOwned, own, resolve, type Ctx, type Observation } from "./paths"
import {
  RunnerError,
  type EditRequest,
  type ReadRequest,
  type ReadResult,
  type WriteRequest,
} from "./protocol"

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

async function observe(abs: string): Promise<(Observation & { data: Buffer }) | null> {
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat) return null
  if (!stat.isFile()) throw new RunnerError(400, "not a file")
  const data = await fs.readFile(abs)
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(data), data }
}

// P4: changing a file that exists needs a read of it in this runner, and is
// refused when the file changed since (a command, another edit)
function checkSeen(ctx: Ctx, rel: string, current: Observation | null) {
  if (!current) return
  const seen = ctx.seen.get(rel)
  if (seen === undefined) {
    throw new RunnerError(409, `${rel} exists and you haven't read it: read it first`)
  }
  if (seen === null || seen.sha256 !== current.sha256) {
    throw new RunnerError(409, `${rel} changed since you read it: read it again`)
  }
}

async function put(ctx: Ctx, rel: string, abs: string, content: string | Buffer) {
  await mkdirOwned(ctx, path.dirname(abs))
  const created = !(await fs.stat(abs).catch(() => null))
  await fs.writeFile(abs, content)
  if (created) await own(ctx, abs)
  const stat = await fs.stat(abs)
  const digest = sha256(content)
  ctx.seen.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest })
  return digest
}

export async function readFile(ctx: Ctx, request: ReadRequest): Promise<ReadResult> {
  const { abs, rel } = await resolve(ctx, request.path)
  const current = await observe(abs).catch((error) => {
    throw error instanceof RunnerError
      ? new RunnerError(400, `${rel} is a folder; list it instead`)
      : error
  })
  if (!current) {
    ctx.seen.set(rel, null)
    throw new RunnerError(404, `${rel} doesn't exist`)
  }
  const { data, ...observation } = current
  ctx.seen.set(rel, observation)
  if (request.encoding === "base64") {
    if (data.length > ctx.limits.readBytes) {
      throw new RunnerError(
        413,
        `${rel} is larger than a read allows; use a command instead`
      )
    }
    return {
      base64: data.toString("base64"),
      bytes: data.length,
      sha256: observation.sha256,
    }
  }
  if (data.subarray(0, 8000).includes(0)) {
    return { binary: true, bytes: data.length, sha256: observation.sha256 }
  }
  const text = data.toString("utf8")
  // Lines with their newline, so a slice joins back to the exact text
  const all = text === "" ? [] : text.split(/(?<=\n)/)
  const start = request.startLine ?? 1
  const wantedEnd = request.endLine ?? all.length
  const end = Math.min(wantedEnd, start - 1 + ctx.limits.readLines)
  let out = all.slice(start - 1, end).join("")
  let truncated = end < Math.min(wantedEnd, all.length)
  if (out.length > ctx.limits.readBytes) {
    out = out.slice(0, ctx.limits.readBytes)
    truncated = true
  }
  return { text: out, lines: all.length, sha256: observation.sha256, truncated }
}

export async function writeFile(ctx: Ctx, request: WriteRequest) {
  const { abs, rel } = await resolve(ctx, request.path, true)
  const current = await observe(abs)
  checkSeen(ctx, rel, current)
  if (request.expectSha256 && current?.sha256 !== request.expectSha256) {
    throw new RunnerError(
      409,
      `${rel} on disk isn't the version you expected: read it again`
    )
  }
  const content =
    request.encoding === "base64"
      ? Buffer.from(request.content, "base64")
      : request.content
  return { sha256: await put(ctx, rel, abs, content), created: !current }
}

export async function editFile(ctx: Ctx, request: EditRequest) {
  const { abs, rel } = await resolve(ctx, request.path, true)
  const current = await observe(abs)
  if (!current) throw new RunnerError(404, `${rel} doesn't exist`)
  checkSeen(ctx, rel, current)
  const text = current.data.toString("utf8")
  const replacements = text.split(request.oldText).length - 1
  if (replacements === 0) throw new RunnerError(422, `oldText not found in ${rel}`)
  if (replacements > 1 && !request.replaceAll) {
    throw new RunnerError(
      422,
      `${replacements} matches of oldText in ${rel}: add surrounding lines to make it unique, or set replaceAll`
    )
  }
  const next = request.replaceAll
    ? text.split(request.oldText).join(request.newText)
    : text.replace(request.oldText, () => request.newText)
  return { sha256: await put(ctx, rel, abs, next), replacements }
}

type Planned =
  | { op: "add" | "update"; rel: string; abs: string; content: string }
  | { op: "delete"; rel: string; abs: string }
  | {
      op: "move"
      rel: string
      abs: string
      content: string
      from: { rel: string; abs: string }
    }

// P3: every section is checked and computed before anything is written
export async function applyPatch(ctx: Ctx, patch: string) {
  let ops
  try {
    ops = parsePatch(patch)
  } catch (error) {
    if (error instanceof PatchError) throw new RunnerError(422, error.message)
    throw error
  }
  const planned: Planned[] = []
  for (const op of ops) {
    const target = await resolve(ctx, op.path, true)
    const current = await observe(target.abs)
    if (op.type === "add") {
      checkSeen(ctx, target.rel, current)
      planned.push({ op: "add", ...target, content: op.content })
      continue
    }
    if (!current) throw new RunnerError(422, `${target.rel} doesn't exist`)
    checkSeen(ctx, target.rel, current)
    if (op.type === "delete") {
      planned.push({ op: "delete", ...target })
      continue
    }
    let content
    try {
      content = applyHunks(current.data.toString("utf8"), op.hunks)
    } catch (error) {
      if (error instanceof PatchError)
        throw new RunnerError(422, `${target.rel}: ${error.message}`)
      throw error
    }
    if (op.moveTo) {
      const dest = await resolve(ctx, op.moveTo, true)
      checkSeen(ctx, dest.rel, await observe(dest.abs))
      planned.push({ op: "move", ...dest, content, from: target })
    } else {
      planned.push({ op: "update", ...target, content })
    }
  }
  for (const step of planned) {
    if (step.op === "delete") {
      await fs.rm(step.abs)
      ctx.seen.set(step.rel, null)
      continue
    }
    await put(ctx, step.rel, step.abs, step.content)
    if (step.op === "move") {
      await fs.rm(step.from.abs)
      ctx.seen.set(step.from.rel, null)
    }
  }
  return { files: planned.map((step) => ({ path: step.rel, op: step.op })) }
}
