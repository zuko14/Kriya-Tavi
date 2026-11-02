import fs from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"

// A minimal ustar writer for runner tests: system tar differs between
// macOS and Linux and won't write the hostile entries the import must refuse.

export type TarEntry = {
  name: string
  type?: "file" | "dir" | "symlink" | "hardlink" | "char" | "pax-global"
  content?: string | Buffer
  mode?: number
  linkname?: string
}

const FLAGS = {
  file: "0",
  hardlink: "1",
  symlink: "2",
  char: "3",
  dir: "5",
  "pax-global": "g",
} as const

function header(name: string, size: number, flag: string, mode: number, linkname = "") {
  const h = Buffer.alloc(512)
  const put = (value: string, offset: number, length: number) =>
    h.write(value.slice(0, length), offset, length, "utf8")
  const octal = (value: number, offset: number, length: number) =>
    put(value.toString(8).padStart(length - 1, "0") + "\0", offset, length)
  put(name, 0, 100)
  octal(mode, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(0, 136, 12)
  put("        ", 148, 8)
  put(flag, 156, 1)
  put(linkname, 157, 100)
  put("ustar\0", 257, 6)
  put("00", 263, 2)
  let sum = 0
  for (const byte of h) sum += byte
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8)
  return h
}

const pad = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])

function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length) length++
  return `${length}${body}`
}

export function tarball(entries: TarEntry[]) {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const type = entry.type ?? "file"
    const data = Buffer.from(entry.content ?? "")
    const mode = entry.mode ?? (type === "dir" ? 0o755 : 0o644)
    if (entry.name.length > 100) {
      const pax = Buffer.from(paxRecord("path", entry.name))
      blocks.push(header("PaxHeader", pax.length, "x", 0o644), pad(pax))
    }
    blocks.push(header(entry.name, data.length, FLAGS[type], mode, entry.linkname))
    if (data.length) blocks.push(pad(data))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

// A directory as GitHub serves it: one top-level folder and a global pax
// header carrying the commit
export function packDirectory(dir: string, top = "owner-repo-0123456") {
  const entries: TarEntry[] = [
    {
      name: "pax_global_header",
      type: "pax-global",
      content: paxRecord("comment", "0".repeat(40)),
    },
    { name: `${top}/`, type: "dir" },
  ]
  const walk = (rel: string) => {
    for (const item of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = path.posix.join(rel, item.name)
      if (item.isDirectory()) {
        entries.push({ name: `${top}/${name}/`, type: "dir" })
        walk(name)
      } else {
        const full = path.join(dir, name)
        entries.push({
          name: `${top}/${name}`,
          content: fs.readFileSync(full),
          mode: fs.statSync(full).mode & 0o777,
        })
      }
    }
  }
  walk("")
  return tarball(entries)
}
