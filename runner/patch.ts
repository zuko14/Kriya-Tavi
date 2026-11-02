// Adapted from DeepSeek Harness @ ce7073d51254c26cd63b22a60835b8f948deb447 (MIT, NOTICE.md):
// fs/fs-patch (parse.ts, apply.ts)

// The `*** Begin Patch` format models already write: Add, Update (with an
// optional Move to) and Delete sections, hunks of " ", "-" and "+" lines.
// Pure string work; runner/files.ts does the I/O, all or nothing.

export type Hunk = {
  // The text after "@@", a line to seek to before matching
  context: string | null
  lines: { kind: " " | "-" | "+"; text: string }[]
  endOfFile: boolean
}

export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo: string | null; hunks: Hunk[] }

export class PatchError extends Error {}

const HEADERS = {
  add: "*** Add File: ",
  delete: "*** Delete File: ",
  update: "*** Update File: ",
  move: "*** Move to: ",
}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  while (lines.length && lines.at(-1)!.trim() === "") lines.pop()
  while (lines.length && lines[0].trim() === "") lines.shift()
  if (
    lines[0]?.trim() !== "*** Begin Patch" ||
    lines.at(-1)?.trim() !== "*** End Patch"
  ) {
    throw new PatchError(
      "a patch starts with *** Begin Patch and ends with *** End Patch"
    )
  }
  const ops: PatchOp[] = []
  let i = 1
  const end = lines.length - 1
  const isHeader = (line: string) => line.startsWith("*** ") && line !== "*** End of File"

  while (i < end) {
    const line = lines[i]
    if (line.startsWith(HEADERS.add)) {
      const path = line.slice(HEADERS.add.length).trim()
      const body: string[] = []
      for (i++; i < end && !isHeader(lines[i]); i++) {
        if (!lines[i].startsWith("+")) {
          throw new PatchError(`line ${i + 1}: every line of an added file starts with +`)
        }
        body.push(lines[i].slice(1))
      }
      ops.push({ type: "add", path, content: body.length ? `${body.join("\n")}\n` : "" })
    } else if (line.startsWith(HEADERS.delete)) {
      ops.push({ type: "delete", path: line.slice(HEADERS.delete.length).trim() })
      i++
    } else if (line.startsWith(HEADERS.update)) {
      const path = line.slice(HEADERS.update.length).trim()
      let moveTo: string | null = null
      i++
      if (lines[i]?.startsWith(HEADERS.move)) {
        moveTo = lines[i].slice(HEADERS.move.length).trim()
        i++
      }
      const hunks: Hunk[] = []
      let hunk: Hunk | null = null
      for (; i < end && !isHeader(lines[i]); i++) {
        const l = lines[i]
        if (l.startsWith("@@")) {
          hunk = { context: l.slice(2).trim() || null, lines: [], endOfFile: false }
          hunks.push(hunk)
        } else if (l === "*** End of File") {
          if (hunk) hunk.endOfFile = true
        } else {
          if (!hunk) {
            hunk = { context: null, lines: [], endOfFile: false }
            hunks.push(hunk)
          }
          // A bare empty line is an empty context line (models drop the space)
          const kind = l === "" ? " " : l[0]
          if (kind !== " " && kind !== "-" && kind !== "+") {
            throw new PatchError(`line ${i + 1}: hunk lines start with " ", "-" or "+"`)
          }
          hunk.lines.push({ kind, text: l.slice(1) })
        }
      }
      if (!hunks.some((h) => h.lines.length) && !moveTo) {
        throw new PatchError(`${path}: an update needs at least one hunk`)
      }
      ops.push({
        type: "update",
        path,
        moveTo,
        hunks: hunks.filter((h) => h.lines.length),
      })
    } else {
      throw new PatchError(
        `line ${i + 1}: expected *** Add File, *** Update File or *** Delete File`
      )
    }
  }
  if (!ops.length) throw new PatchError("the patch changes nothing")
  for (const op of ops) if (!op.path) throw new PatchError("a section has no path")
  return ops
}

// Exact first, then ignoring trailing spaces, then ignoring both ends
const FUZZ = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]

function find(lines: string[], wanted: string[], from: number, atEnd: boolean) {
  for (const norm of FUZZ) {
    const target = wanted.map(norm)
    const starts = atEnd
      ? [lines.length - wanted.length]
      : Array.from(
          { length: lines.length - wanted.length - from + 1 },
          (_, k) => from + k
        )
    for (const start of starts) {
      if (start < from) continue
      if (target.every((t, k) => norm(lines[start + k]) === t)) return start
    }
  }
  return -1
}

export function applyHunks(content: string, hunks: Hunk[]) {
  const trailingNewline = content === "" || content.endsWith("\n")
  const lines = content === "" ? [] : content.split("\n")
  if (content.endsWith("\n")) lines.pop()
  let cursor = 0
  hunks.forEach((hunk, n) => {
    if (hunk.context) {
      const at = find(lines, [hunk.context], cursor, false)
      if (at < 0)
        throw new PatchError(`hunk ${n + 1}: "${hunk.context}" isn't in the file`)
      cursor = at + 1
    }
    const before = hunk.lines.filter((l) => l.kind !== "+").map((l) => l.text)
    const after = hunk.lines.filter((l) => l.kind !== "-").map((l) => l.text)
    let at: number
    if (!before.length) {
      at = hunk.endOfFile || !hunk.context ? lines.length : cursor
    } else {
      at = hunk.endOfFile ? find(lines, before, cursor, true) : -1
      if (at < 0) at = find(lines, before, cursor, false)
      if (at < 0)
        throw new PatchError(`hunk ${n + 1} doesn't match the file; read it again`)
    }
    lines.splice(at, before.length, ...after)
    cursor = at + after.length
  })
  return lines.length ? lines.join("\n") + (trailingNewline ? "\n" : "") : ""
}
