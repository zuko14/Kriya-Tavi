import fs from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"

import { claimRepo, hasRepo, initRepo, repoClaimed } from "./git"
import { mkdirOwned, own, OWN_DIR, type Ctx } from "./paths"
import { RunnerError, type ImportResult } from "./protocol"

// A repository archive (GitHub's tarball, gzip tar) into an empty
// workspace, once per generation. The whole archive is read and checked
// before a single file is written.

type Entry =
  | { type: "file"; path: string; data: Buffer; mode: number }
  | { type: "dir"; path: string }
  | { type: "symlink"; path: string; target: string }

const text = (block: Buffer, offset: number, length: number) => {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? length : end).toString("utf8")
}

function octal(block: Buffer, offset: number, length: number) {
  if (block[offset] & 0x80)
    throw new RunnerError(400, "the archive has an entry too large to import")
  const value = Number.parseInt(text(block, offset, length).trim() || "0", 8)
  if (!Number.isFinite(value)) throw new RunnerError(400, "the archive isn't a valid tar")
  return value
}

function paxRecords(data: Buffer) {
  const records: Record<string, string> = {}
  let rest = data.toString("utf8")
  while (rest.length) {
    const space = rest.indexOf(" ")
    const length = Number.parseInt(rest.slice(0, space), 10)
    if (!(length > 0)) break
    const record = rest.slice(space + 1, length - 1)
    const eq = record.indexOf("=")
    records[record.slice(0, eq)] = record.slice(eq + 1)
    rest = rest.slice(length)
  }
  return records
}

function parseTar(tar: Buffer) {
  const entries: Entry[] = []
  let pax: Record<string, string> = {}
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
    if (sum !== octal(header, 148, 8))
      throw new RunnerError(400, "the archive isn't a valid tar")
    const size = octal(header, 124, 12)
    const flag = String.fromCharCode(header[156])
    const prefix = text(header, 257, 6).startsWith("ustar") ? text(header, 345, 155) : ""
    const name =
      pax.path ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))
    const data = tar.subarray(offset + 512, offset + 512 + size)
    if (data.length < size) throw new RunnerError(400, "the archive is cut short")
    offset += 512 + Math.ceil(size / 512) * 512
    if (flag === "x") {
      pax = paxRecords(data)
      continue
    }
    if (flag === "g") continue
    const linkname = pax.linkpath ?? text(header, 157, 100)
    pax = {}
    if (flag === "0" || flag === "\0" || flag === "7") {
      entries.push({ type: "file", path: name, data, mode: octal(header, 100, 8) })
    } else if (flag === "5") {
      entries.push({ type: "dir", path: name })
    } else if (flag === "2") {
      entries.push({ type: "symlink", path: name, target: linkname })
    } else {
      throw new RunnerError(
        400,
        `${name}: hard links, devices and special files aren't imported`
      )
    }
  }
  return entries
}

// Normalised relative path, or a refusal naming the entry
function checkPath(raw: string, strip: number) {
  if (raw.startsWith("/"))
    throw new RunnerError(400, `${raw}: absolute paths aren't imported`)
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.includes(".."))
    throw new RunnerError(400, `${raw}: paths with .. aren't imported`)
  const kept = parts.slice(strip)
  if (kept[0] === ".git" || kept[0] === OWN_DIR) {
    throw new RunnerError(400, `${raw}: ${kept[0]} isn't imported`)
  }
  return kept.join("/")
}

export async function importArchive(
  ctx: Ctx,
  body: Buffer,
  options: { strip: number; base: string | null }
): Promise<ImportResult> {
  if (repoClaimed(ctx) || importing.has(ctx)) throw already()
  importing.add(ctx)
  try {
    if (await hasRepo(ctx)) throw already()
    return await extract(ctx, body, options)
  } finally {
    importing.delete(ctx)
  }
}

const importing = new WeakSet<Ctx>()
const already = () =>
  new RunnerError(409, "this workspace already has its files for this generation")

async function extract(
  ctx: Ctx,
  body: Buffer,
  options: { strip: number; base: string | null }
): Promise<ImportResult> {
  const { importBytes, importFiles } = ctx.limits
  let tar: Buffer
  try {
    // Tar headers add about 1 KB per entry on top of the file bytes
    tar = gunzipSync(body, {
      maxOutputLength: importBytes + importFiles * 1024 + 1024 * 1024,
    })
  } catch (error) {
    if (error instanceof RangeError) {
      throw new RunnerError(413, "the repository is larger than this workspace allows")
    }
    throw new RunnerError(400, "the archive isn't gzip")
  }

  const planned: Entry[] = []
  const links = new Set<string>()
  let files = 0
  let bytes = 0
  for (const entry of parseTar(tar)) {
    const rel = checkPath(entry.path, options.strip)
    if (!rel) continue
    const parts = rel.split("/")
    for (let i = 1; i < parts.length; i++) {
      if (links.has(parts.slice(0, i).join("/"))) {
        throw new RunnerError(400, `${entry.path}: goes through a symbolic link`)
      }
    }
    if (entry.type === "symlink") {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), entry.target)
      )
      if (entry.target.startsWith("/") || target === ".." || target.startsWith("../")) {
        throw new RunnerError(
          400,
          `${entry.path}: links pointing outside aren't imported`
        )
      }
      links.add(rel)
    }
    if (entry.type !== "dir") files++
    if (entry.type === "file") bytes += entry.data.length
    if (files > importFiles) {
      throw new RunnerError(413, `the repository has more than ${importFiles} files`)
    }
    if (bytes > importBytes) {
      throw new RunnerError(413, "the repository is larger than this workspace allows")
    }
    planned.push({ ...entry, path: rel })
  }

  const work = (async () => {
    for (const entry of planned) {
      const abs = path.join(ctx.root, entry.path)
      if (entry.type === "dir") {
        await mkdirOwned(ctx, abs)
      } else if (entry.type === "file") {
        await mkdirOwned(ctx, path.dirname(abs))
        await fs.writeFile(abs, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 })
        await own(ctx, abs)
      }
    }
    // Links last, so no file is written through one
    for (const entry of planned) {
      if (entry.type !== "symlink") continue
      const abs = path.join(ctx.root, entry.path)
      await mkdirOwned(ctx, path.dirname(abs))
      await fs.symlink(entry.target, abs)
      await own(ctx, abs)
    }
    const message = options.base ? `Base ${options.base}` : "Base"
    return initRepo(ctx, message, true)
  })()
  claimRepo(ctx, work)
  return { files, bytes, baseCommit: await work }
}
