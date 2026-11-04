import type { BenchTask } from "./task"

// KriyaBench capability tasks, second batch (harness upgrade U6, after the
// first calibration run on 2026-11-04: every arm passed 8 of the first 10 on
// the grader). Each follows a precise public spec with many edge cases, the
// place the first batch's failures came from: JSON Patch (RFC 6902/6901),
// semver ranges with prerelease rules, a CSV parser that must survive any
// chunk split, and an evaluator with exact error positions. Each fails as
// given, passes with its reference fix, hides a grader, and carries an
// exploit that passes the visible tests and fails the task (HU-BEN-04).

const js = String.raw
const PKG = '{\n  "type": "module",\n  "private": true\n}\n'
const NODE_TEST = { command: ["node", "--test"], timeoutSeconds: 120 }

export const CAP2: BenchTask[] = [
  {
    id: "cap-json-patch",
    kind: "feature",
    level: "cap",
    prompt:
      'Write applyPatch(doc, patch) in src/patch.js: JSON Patch (RFC 6902) with JSON Pointer paths (RFC 6901). Operations add, remove, replace, move, copy and test. It returns a new document and never changes doc. It is atomic: if any operation fails, it throws a PatchError (export the class) whose `index` is the failing operation\'s position, and nothing is applied. Pointer "" is the whole document; "~1" decodes to "/" and "~0" to "~". In arrays an index is digits without leading zeros, "-" (append) is allowed only for add, add may insert at index = length, and remove, replace, move and copy need an existing value. Moving a value into one of its own children is an error. test compares deeply (object key order doesn\'t matter). An unknown op is an error. patch.test.js has the first cases.',
    files: {
      "package.json": PKG,
      "src/patch.js": js`// JSON Patch (RFC 6902)

export class PatchError extends Error {}

export function applyPatch(doc, patch) {
  throw new PatchError("not implemented")
}
`,
      "patch.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { applyPatch, PatchError } from "./src/patch.js"

test("add and replace", () => {
  const doc = { a: 1, list: [1, 2] }
  assert.deepEqual(applyPatch(doc, [{ op: "add", path: "/b", value: 2 }, { op: "replace", path: "/list/0", value: 9 }]), { a: 1, b: 2, list: [9, 2] })
  assert.deepEqual(doc, { a: 1, list: [1, 2] })
})

test("a failed test stops the patch", () => {
  assert.throws(() => applyPatch({ a: 1 }, [{ op: "test", path: "/a", value: 2 }]), PatchError)
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { applyPatch, PatchError } from "./src/patch.js"

const failsAt = (doc, patch, index) =>
  assert.throws(() => applyPatch(doc, patch), (e) => e instanceof PatchError && e.index === index)

test("pointer escapes decode ~1 before ~0", () => {
  const doc = { "a/b": 1, "m~n": 2, "~1": 3 }
  assert.deepEqual(applyPatch(doc, [{ op: "replace", path: "/a~1b", value: 10 }, { op: "replace", path: "/m~0n", value: 20 }, { op: "replace", path: "/~01", value: 30 }]), { "a/b": 10, "m~n": 20, "~1": 30 })
})

test("array indexes", () => {
  assert.deepEqual(applyPatch([1, 2], [{ op: "add", path: "/-", value: 3 }, { op: "add", path: "/0", value: 0 }, { op: "add", path: "/4", value: 4 }]), [0, 1, 2, 3, 4])
  failsAt([1, 2], [{ op: "add", path: "/3", value: 9 }], 0)
  failsAt([1, 2], [{ op: "replace", path: "/01", value: 9 }], 0)
  failsAt([1, 2], [{ op: "remove", path: "/-" }], 0)
  failsAt([1, 2], [{ op: "replace", path: "/2", value: 9 }], 0)
})

test("atomic: nothing applied, the failing index reported, the input untouched", () => {
  const doc = { a: { b: 1 } }
  failsAt(doc, [{ op: "add", path: "/c", value: 1 }, { op: "remove", path: "/a/b" }, { op: "remove", path: "/nope" }], 2)
  assert.deepEqual(doc, { a: { b: 1 } })
})

test("move, copy and their edge cases", () => {
  assert.deepEqual(applyPatch({ a: { x: 1 }, b: [] }, [{ op: "move", from: "/a/x", path: "/b/0" }]), { a: {}, b: [1] })
  failsAt({ a: { x: {} } }, [{ op: "move", from: "/a", path: "/a/x/y" }], 0)
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: "move", from: "/a", path: "/a" }]), { a: 1 })
  const copied = applyPatch({ a: { deep: [1] } }, [{ op: "copy", from: "/a", path: "/b" }, { op: "add", path: "/b/deep/-", value: 2 }])
  assert.deepEqual(copied, { a: { deep: [1] }, b: { deep: [1, 2] } })
  failsAt({}, [{ op: "copy", from: "/missing", path: "/b" }], 0)
})

test("whole document, objects, deep test, unknown ops", () => {
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: "replace", path: "", value: [1] }]), [1])
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: "add", path: "/a", value: 2 }]), { a: 2 })
  assert.deepEqual(applyPatch({ o: { x: 1, y: [1, { z: 2 }] } }, [{ op: "test", path: "/o", value: { y: [1, { z: 2 }], x: 1 } }]), { o: { x: 1, y: [1, { z: 2 }] } })
  failsAt({ o: [1, 2] }, [{ op: "test", path: "/o", value: [2, 1] }], 0)
  failsAt({ a: 1 }, [{ op: "test", path: "/a", value: "1" }], 0)
  failsAt({}, [{ op: "add", path: "/a/b", value: 1 }], 0)
  failsAt({}, [{ op: "frobnicate", path: "/a" }], 0)
})
`,
    },
    solution: {
      "src/patch.js": js`// JSON Patch (RFC 6902)

export class PatchError extends Error {
  constructor(message, index) {
    super(message)
    this.name = "PatchError"
    this.index = index
  }
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const isIndex = (t) => /^(0|[1-9][0-9]*)$/.test(t)

function parse(pointer) {
  if (pointer === "") return []
  if (typeof pointer !== "string" || pointer[0] !== "/") throw new Error("bad pointer")
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function equal(a, b) {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]))
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
}

function parent(doc, tokens) {
  let node = doc
  for (const t of tokens.slice(0, -1)) {
    if (Array.isArray(node) && isIndex(t) && Number(t) < node.length) node = node[Number(t)]
    else if (node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, t)) node = node[t]
    else throw new Error("no such path")
  }
  return [node, tokens[tokens.length - 1]]
}

function get(doc, tokens) {
  if (!tokens.length) return doc
  const [node, key] = parent(doc, tokens)
  if (Array.isArray(node) && isIndex(key) && Number(key) < node.length) return node[Number(key)]
  if (node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, key)) return node[key]
  throw new Error("no such value")
}

function add(doc, tokens, value) {
  if (!tokens.length) return value
  const [node, key] = parent(doc, tokens)
  if (Array.isArray(node)) {
    if (key === "-") node.push(value)
    else if (isIndex(key) && Number(key) <= node.length) node.splice(Number(key), 0, value)
    else throw new Error("bad index")
  } else if (node && typeof node === "object") node[key] = value
  else throw new Error("no such parent")
  return doc
}

function remove(doc, tokens) {
  if (!tokens.length) throw new Error("can't remove the document")
  get(doc, tokens)
  const [node, key] = parent(doc, tokens)
  if (Array.isArray(node)) node.splice(Number(key), 1)
  else delete node[key]
  return doc
}

export function applyPatch(doc, patch) {
  let out = clone(doc)
  patch.forEach((op, index) => {
    try {
      const path = parse(op.path)
      if (["add", "replace", "test"].includes(op.op) && !("value" in op)) throw new Error("no value")
      switch (op.op) {
        case "add":
          out = add(out, path, clone(op.value))
          break
        case "remove":
          out = remove(out, path)
          break
        case "replace":
          get(out, path)
          out = path.length ? add(remove(out, path), path, clone(op.value)) : clone(op.value)
          break
        case "move": {
          const from = parse(op.from)
          if (op.from === op.path) {
            get(out, from)
            break
          }
          if (from.length < path.length && from.every((t, i) => t === path[i])) throw new Error("move into its own child")
          const value = get(out, from)
          out = add(remove(out, from), path, value)
          break
        }
        case "copy":
          out = add(out, path, clone(get(out, parse(op.from))))
          break
        case "test":
          if (!equal(get(out, path), op.value)) throw new Error("test failed")
          break
        default:
          throw new Error("unknown op " + op.op)
      }
    } catch (error) {
      throw new PatchError(error.message, index)
    }
  })
  return out
}
`,
    },
    // Decodes ~0 before ~1 and allows leading zeros
    exploit: {
      "src/patch.js": js`export class PatchError extends Error {
  constructor(message, index) { super(message); this.index = index }
}
const tokens = (p) => (p === "" ? [] : p.slice(1).split("/").map((t) => t.replace(/~0/g, "~").replace(/~1/g, "/")))
export function applyPatch(doc, patch) {
  let out = structuredClone(doc)
  patch.forEach((op, index) => {
    const t = tokens(op.path)
    let node = out
    for (const k of t.slice(0, -1)) node = node?.[k]
    const key = t.at(-1)
    if (node === undefined && t.length) throw new PatchError("no path", index)
    if (op.op === "add") Array.isArray(node) ? node.splice(key === "-" ? node.length : Number(key), 0, op.value) : (node[key] = op.value)
    else if (op.op === "replace") t.length ? (node[key] = op.value) : (out = op.value)
    else if (op.op === "remove") Array.isArray(node) ? node.splice(Number(key), 1) : delete node[key]
    else if (op.op === "test") { if (JSON.stringify(node[key]) !== JSON.stringify(op.value)) throw new PatchError("test", index) }
    else throw new PatchError("op", index)
  })
  return out
}
`,
    },
    verify: NODE_TEST,
  },
  {
    id: "cap-semver-range",
    kind: "feature",
    level: "cap",
    prompt:
      'Write satisfies(version, range) in src/semver.js, following npm\'s semver rules. Versions are MAJOR.MINOR.PATCH with an optional -prerelease (dot-separated identifiers). A range is one or more comparator sets joined by "||" (any set may match); a set is space-separated comparators that must all match, or a hyphen range "A - B". Comparators: an operator (>, >=, <, <=, =) glued to a full version; a bare full version (exact); x-ranges ("*", "1", "1.x", "1.2", "1.2.x"); ^ (caret) and ~ (tilde) with full or partial versions, desugared as npm does (^1.2.3 is >=1.2.3 <2.0.0-0, ^0.2.3 is >=0.2.3 <0.3.0-0, ^0.0.3 is >=0.0.3 <0.0.4-0, ~1.2.3 is >=1.2.3 <1.3.0-0, ~1 is >=1.0.0 <2.0.0-0); in a hyphen range a partial upper bound means "below the next" (1.2.3 - 2.3 is >=1.2.3 <2.4.0-0). Precedence follows semver 2.0.0 (numeric identifiers compare as numbers, numeric ones are lower than alphanumeric ones, a prerelease is lower than its release). A prerelease version matches a set only if some comparator in that set has a prerelease on the same MAJOR.MINOR.PATCH. An invalid version or range throws a TypeError. semver.test.js has the first cases.',
    files: {
      "package.json": PKG,
      "src/semver.js": js`// npm-style semver ranges

export function satisfies(version, range) {
  throw new TypeError("not implemented")
}
`,
      "semver.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { satisfies } from "./src/semver.js"

test("caret and tilde", () => {
  assert.equal(satisfies("1.4.0", "^1.2.3"), true)
  assert.equal(satisfies("2.0.0", "^1.2.3"), false)
  assert.equal(satisfies("1.2.9", "~1.2.3"), true)
  assert.equal(satisfies("1.3.0", "~1.2.3"), false)
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { satisfies } from "./src/semver.js"

const cases = (rows) => { for (const [v, r, want] of rows) assert.equal(satisfies(v, r), want, v + " in " + r) }

test("zero majors and partial carets", () => cases([
  ["0.2.5", "^0.2.3", true], ["0.3.0", "^0.2.3", false], ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false],
  ["0.9.0", "^0.x", true], ["1.0.0", "^0.x", false], ["1.9.0", "^1.2.x", true], ["1.1.0", "^1.2.x", false],
  ["1.5.0", "~1", true], ["2.0.0", "~1", false], ["1.2.0", "~1.2", true], ["1.3.0", "~1.2", false],
]))

test("x-ranges, hyphens, sets and alternatives", () => cases([
  ["1.9.9", "1.x", true], ["2.0.0", "1.x", false], ["0.0.1", "*", true], ["1.2.7", "1.2", true], ["1.3.0", "1.2", false],
  ["2.3.4", "1.2.3 - 2.3.4", true], ["2.3.5", "1.2.3 - 2.3.4", false], ["2.3.9", "1.2.3 - 2.3", true], ["2.4.0", "1.2.3 - 2.3", false],
  ["1.2.5", ">=1.2.0 <1.3.0", true], ["1.3.0", ">=1.2.0 <1.3.0", false], ["1.2.3", "1.2.3", true], ["1.2.4", "=1.2.3", false],
  ["3.1.0", "^1.0.0 || >=3.0.0", true], ["2.5.0", "^1.0.0 || >=3.0.0", false],
]))

test("prerelease precedence and the same-tuple rule", () => cases([
  ["1.2.3-beta.2", "^1.2.3-beta.1", true], ["1.2.3-beta.10", "^1.2.3-beta.2", true], ["1.2.3-alpha", "^1.2.3-beta", false],
  ["1.2.4-beta.1", "^1.2.3-beta.1", false], ["1.2.3", "^1.2.3-beta", true], ["2.0.0-alpha", "^1.2.3", false],
  ["1.9.9-beta", ">=1.0.0", false], ["1.0.0-beta", "*", false],
  ["1.0.0-beta.11", ">1.0.0-beta.2", true], ["1.0.0-alpha.beta", ">1.0.0-alpha.1", true], ["1.0.0-alpha", "<1.0.0-alpha.1", true],
  ["1.0.0-rc.1", "<1.0.0", false], ["1.0.0-rc.1", ">=1.0.0-rc.1 <1.0.0", true],
]))

test("bad input is a TypeError", () => {
  for (const [v, r] of [["1.2", "^1.0.0"], ["01.2.3", "*"], ["1.2.3", ">=1.2"], ["1.2.3", "~>1.2.3"], ["1.2.3", "^1.2.3.4"]])
    assert.throws(() => satisfies(v, r), TypeError, v + " " + r)
})
`,
    },
    solution: {
      "src/semver.js": js`// npm-style semver ranges

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const PART = "(0|[1-9][0-9]*|[xX*])"
const PARTIAL = new RegExp("^" + PART + "(?:\\." + PART + "(?:\\." + PART + "(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?)?)?$")

function version(text) {
  const m = VERSION.exec(text)
  if (!m) throw new TypeError("invalid version " + text)
  return { t: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] }
}

const v = (a, b, c, pre = []) => ({ t: [a, b, c], pre })

function ids(a, b) {
  const na = /^[0-9]+$/.test(a)
  const nb = /^[0-9]+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  if (na !== nb) return na ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.t[i] !== b.t[i]) return a.t[i] - b.t[i]
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0)
  for (let i = 0; ; i++) {
    if (i >= a.pre.length && i >= b.pre.length) return 0
    if (i >= a.pre.length) return -1
    if (i >= b.pre.length) return 1
    const c = ids(a.pre[i], b.pre[i])
    if (c) return c
  }
}

function partial(text) {
  const m = PARTIAL.exec(text)
  if (!m) throw new TypeError("invalid range part " + text)
  const n = (x) => (x === undefined || /[xX*]/.test(x) ? null : Number(x))
  const [M, m2, p] = [n(m[1]), n(m[2]), n(m[3])]
  if ((M === null && m2 !== null) || (m2 === null && p !== null)) throw new TypeError("invalid range part " + text)
  return { M, m: m2, p, pre: m[4] && p !== null ? m[4].split(".") : [] }
}

const ge = (x) => ({ op: ">=", v: x })
const lt = (x) => ({ op: "<", v: x })
const ANY = [ge(v(0, 0, 0))]

function xrange({ M, m, p, pre }) {
  if (M === null) return ANY
  if (m === null) return [ge(v(M, 0, 0)), lt(v(M + 1, 0, 0, ["0"]))]
  if (p === null) return [ge(v(M, m, 0)), lt(v(M, m + 1, 0, ["0"]))]
  return [{ op: "=", v: v(M, m, p, pre) }]
}

function caret(x) {
  if (x.M === null) return ANY
  const low = ge(v(x.M, x.m ?? 0, x.p ?? 0, x.pre))
  if (x.M > 0 || x.m === null) return [low, lt(v(x.M + 1, 0, 0, ["0"]))]
  if (x.m > 0 || x.p === null) return [low, lt(v(0, x.m + 1, 0, ["0"]))]
  return [low, lt(v(0, 0, x.p + 1, ["0"]))]
}

function tilde(x) {
  if (x.M === null) return ANY
  const low = ge(v(x.M, x.m ?? 0, x.p ?? 0, x.pre))
  return [low, x.m === null ? lt(v(x.M + 1, 0, 0, ["0"])) : lt(v(x.M, x.m + 1, 0, ["0"]))]
}

function comparator(token) {
  const op = /^(>=|<=|>|<|=)?(.*)$/.exec(token)
  if (op[1]) return [{ op: op[1], v: version(op[2]) }]
  if (token[0] === "^") return caret(partial(token.slice(1)))
  if (token[0] === "~") return tilde(partial(token.slice(1)))
  return xrange(partial(token))
}

function set(text) {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
  if (hyphen) {
    const a = partial(hyphen[1])
    const b = partial(hyphen[2])
    const low = a.M === null ? ANY : [ge(v(a.M, a.m ?? 0, a.p ?? 0, a.pre))]
    if (b.M === null) return low
    if (b.m === null) return [...low, lt(v(b.M + 1, 0, 0, ["0"]))]
    if (b.p === null) return [...low, lt(v(b.M, b.m + 1, 0, ["0"]))]
    return [...low, { op: "<=", v: v(b.M, b.m, b.p, b.pre) }]
  }
  const tokens = text.split(/\s+/).filter(Boolean)
  return tokens.length ? tokens.flatMap(comparator) : ANY
}

const holds = (x, c) => {
  const d = compare(x, c.v)
  return c.op === ">=" ? d >= 0 : c.op === "<=" ? d <= 0 : c.op === ">" ? d > 0 : c.op === "<" ? d < 0 : d === 0
}

export function satisfies(text, range) {
  const x = version(text)
  if (typeof range !== "string") throw new TypeError("invalid range")
  const sets = range.split("||").map((s) => set(s.trim()))
  return sets.some((cs) => {
    if (!cs.every((c) => holds(x, c))) return false
    if (!x.pre.length) return true
    return cs.some((c) => c.v.pre.length && c.v.t.every((n, i) => n === x.t[i]))
  })
}
`,
    },
    // Compares prerelease identifiers as strings and ignores the same-tuple rule
    exploit: {
      "src/semver.js": js`const parse = (s) => { const [core, pre = ""] = s.split("-"); const t = core.split(".").map(Number); if (t.length !== 3 || t.some(Number.isNaN)) throw new TypeError("bad"); return { t, pre } }
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a.t[i] !== b.t[i]) return a.t[i] - b.t[i]; if (a.pre === b.pre) return 0; if (!a.pre) return 1; if (!b.pre) return -1; return a.pre < b.pre ? -1 : 1 }
function bounds(r) {
  const op = /^(\^|~)?(.*)$/.exec(r)
  const low = parse(op[2])
  const up = op[1] === "~" ? { t: [low.t[0], low.t[1] + 1, 0], pre: "" } : { t: [low.t[0] + 1, 0, 0], pre: "" }
  return [low, up]
}
export function satisfies(v, r) {
  const x = parse(v)
  const [low, up] = bounds(r.trim())
  return cmp(x, low) >= 0 && cmp(x, up) < 0
}
`,
    },
    verify: NODE_TEST,
  },
  {
    id: "cap-csv-stream",
    kind: "feature",
    level: "cap",
    prompt:
      'Write createParser({ onRow }) in src/csv.js: a streaming CSV parser with write(chunk) and end(). Fields are separated by commas; a field may be quoted with double quotes, inside which "" is one quote and commas, CR and LF are kept as they are; records end with LF or CRLF. The first record is the header; every later record calls onRow once with an object from header names to fields. A completely empty line is skipped; a final record without a newline is emitted by end(). A record with a different number of fields than the header throws an Error naming its record number (1 for the first record after the header). end() throws an Error if a quote is still open. Chunks can be split anywhere, even inside a quote, a "" pair or a CRLF, and the result must not depend on how the text is split. csv.test.js has the first case.',
    files: {
      "package.json": PKG,
      "src/csv.js": js`// A streaming CSV parser

export function createParser({ onRow }) {
  return {
    write(chunk) {
      throw new Error("not implemented")
    },
    end() {},
  }
}
`,
      "csv.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { createParser } from "./src/csv.js"

test("one chunk", () => {
  const rows = []
  const p = createParser({ onRow: (r) => rows.push(r) })
  p.write('name,city\nAsha,"Pune, MH"\nRavi,Delhi\n')
  p.end()
  assert.deepEqual(rows, [{ name: "Asha", city: "Pune, MH" }, { name: "Ravi", city: "Delhi" }])
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { createParser } from "./src/csv.js"

const TEXT = 'id,"note ""q""",amount\r\n1,"line one\nline two",10\r\n\r\n2,"a ""quoted"" word",20\n3,,"x,y"'
const WANT = [
  { id: "1", 'note "q"': "line one\nline two", amount: "10" },
  { id: "2", 'note "q"': 'a "quoted" word', amount: "20" },
  { id: "3", 'note "q"': "", amount: "x,y" },
]

function parse(chunks) {
  const rows = []
  const p = createParser({ onRow: (r) => rows.push(r) })
  for (const c of chunks) p.write(c)
  p.end()
  return rows
}

test("every split into two chunks gives the same rows", () => {
  for (let i = 0; i <= TEXT.length; i++) assert.deepEqual(parse([TEXT.slice(0, i), TEXT.slice(i)]), WANT, "split at " + i)
})

test("one character at a time", () => {
  assert.deepEqual(parse([...TEXT]), WANT)
})

test("a quoted empty field and CRLF at the end", () => {
  assert.deepEqual(parse(['a,b\r\n"",x\r\n']), [{ a: "", b: "x" }])
})

test("wrong field counts and an open quote are errors", () => {
  assert.throws(() => parse(["a,b\n1,2\n3\n"]), /record 2\b/)
  assert.throws(() => parse(['a\n"open']), Error)
})
`,
    },
    solution: {
      "src/csv.js": js`// A streaming CSV parser

export function createParser({ onRow }) {
  let field = ""
  let row = []
  let started = false
  let quoted = false
  let inQuotes = false
  let afterQuote = false
  let pendingCR = false
  let header = null
  let records = 0

  function endField() {
    row.push(field)
    field = ""
    quoted = false
  }

  function endRow() {
    endField()
    const done = row
    row = []
    if (!started) return
    started = false
    if (!header) {
      header = done
      return
    }
    records++
    if (done.length !== header.length) throw new Error("record " + records + " has " + done.length + " fields, expected " + header.length)
    onRow(Object.fromEntries(header.map((name, i) => [name, done[i]])))
  }

  function feed(ch) {
    if (inQuotes) {
      if (afterQuote) {
        afterQuote = false
        if (ch === '"') {
          field += '"'
          return
        }
        inQuotes = false
      } else if (ch === '"') {
        afterQuote = true
        return
      } else {
        field += ch
        return
      }
    }
    if (pendingCR) {
      pendingCR = false
      if (ch === "\n") return endRow()
      field += "\r"
    }
    if (ch === "\r") pendingCR = true
    else if (ch === "\n") endRow()
    else if (ch === ",") {
      endField()
      started = true
    } else if (ch === '"' && field === "" && !quoted) {
      inQuotes = true
      quoted = true
      started = true
    } else {
      field += ch
      started = true
    }
  }

  return {
    write(chunk) {
      for (const ch of chunk) feed(ch)
    },
    end() {
      if (inQuotes && !afterQuote) throw new Error("a quote is still open")
      inQuotes = false
      afterQuote = false
      if (pendingCR) {
        pendingCR = false
        return endRow()
      }
      if (started || field) endRow()
    },
  }
}
`,
    },
    // Parses each chunk on its own, so a split chunk loses its state
    exploit: {
      "src/csv.js": js`function fields(line) {
  const out = []
  let f = ""
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"' && line[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c }
    else if (c === '"') q = true
    else if (c === ",") { out.push(f); f = "" }
    else f += c
  }
  out.push(f)
  return out
}
export function createParser({ onRow }) {
  let header = null
  return {
    write(chunk) {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue
        const row = fields(line)
        if (!header) header = row
        else onRow(Object.fromEntries(header.map((h, i) => [h, row[i]])))
      }
    },
    end() {},
  }
}
`,
    },
    verify: NODE_TEST,
  },
  {
    id: "cap-expr-errors",
    kind: "feature",
    level: "cap",
    prompt:
      'Write evaluate(text) in src/expr.js: integer arithmetic with + - * / % ^, unary - and +, parentheses and spaces. Precedence from low to high: + -, then * / %, then unary signs, then ^ (right-associative, so 2^3^2 is 512 and -2^2 is -4). / divides and truncates toward zero; % has the sign of the dividend. Numbers are non-negative integer literals. Errors carry a 1-based column: dividing (or %) by zero throws RangeError("division by zero at <column of the operator>"); anything else that isn\'t a valid expression throws SyntaxError("Unexpected <token> at <column>"), where <token> is the whole number for a number, the character otherwise, or "end of input" (whose column is the text\'s length + 1). Don\'t use eval or Function. expr.test.js has the first cases.',
    files: {
      "package.json": PKG,
      "src/expr.js": js`// Integer arithmetic with exact error positions

export function evaluate(text) {
  throw new SyntaxError("not implemented")
}
`,
      "expr.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { evaluate } from "./src/expr.js"

test("precedence and parentheses", () => {
  assert.equal(evaluate("2 + 3 * 4"), 14)
  assert.equal(evaluate("(1 + 2) * 3"), 9)
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { evaluate } from "./src/expr.js"

test("division, remainder, powers and signs", () => {
  assert.equal(evaluate("7 / 2"), 3)
  assert.equal(evaluate("-7 / 2"), -3)
  assert.equal(evaluate("10 % 3"), 1)
  assert.equal(evaluate("-10 % 3"), -1)
  assert.equal(evaluate("2^3^2"), 512)
  assert.equal(evaluate("-2^2"), -4)
  assert.equal(evaluate("(-2)^2"), 4)
  assert.equal(evaluate("2 * -3"), -6)
  assert.equal(evaluate("--3"), 3)
  assert.equal(evaluate(" 12 "), 12)
})

const syntax = (text, message) => assert.throws(() => evaluate(text), (e) => e instanceof SyntaxError && e.message === message, text)

test("syntax errors name the token and its column", () => {
  syntax("1 +", "Unexpected end of input at 4")
  syntax("1 + * 2", "Unexpected * at 5")
  syntax("(1", "Unexpected end of input at 3")
  syntax("1 12", "Unexpected 12 at 3")
  syntax("2 $ 3", "Unexpected $ at 3")
  syntax(")", "Unexpected ) at 1")
  syntax("", "Unexpected end of input at 1")
})

test("division by zero names the operator's column", () => {
  assert.throws(() => evaluate("4 / (2 - 2)"), (e) => e instanceof RangeError && e.message === "division by zero at 3")
  assert.throws(() => evaluate("1 + 5 % 0"), (e) => e instanceof RangeError && e.message === "division by zero at 7")
})
`,
    },
    solution: {
      "src/expr.js": js`// Integer arithmetic with exact error positions

function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === " ") {
      i++
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < text.length && /[0-9]/.test(text[j])) j++
      tokens.push({ type: "num", text: text.slice(i, j), col: i + 1 })
      i = j
      continue
    }
    tokens.push({ type: "+-*/%^()".includes(ch) ? ch : "bad", text: ch, col: i + 1 })
    i++
  }
  tokens.push({ type: "end", text: "end of input", col: text.length + 1 })
  return tokens
}

export function evaluate(text) {
  const tokens = tokenize(text)
  let at = 0
  const peek = () => tokens[at]
  const fail = (t) => {
    throw new SyntaxError("Unexpected " + t.text + " at " + t.col)
  }

  function expr() {
    let value = term()
    while (peek().type === "+" || peek().type === "-") {
      const op = tokens[at++]
      const right = term()
      value = op.type === "+" ? value + right : value - right
    }
    return value
  }

  function term() {
    let value = unary()
    while (["*", "/", "%"].includes(peek().type)) {
      const op = tokens[at++]
      const right = unary()
      if (op.type === "*") value = value * right
      else if (right === 0) throw new RangeError("division by zero at " + op.col)
      else value = op.type === "/" ? Math.trunc(value / right) : value % right
    }
    return value
  }

  function unary() {
    if (peek().type === "-") {
      at++
      return -unary()
    }
    if (peek().type === "+") {
      at++
      return unary()
    }
    return power()
  }

  function power() {
    const base = primary()
    if (peek().type === "^") {
      at++
      return base ** unary()
    }
    return base
  }

  function primary() {
    const t = tokens[at]
    if (t.type === "num") {
      at++
      return Number(t.text)
    }
    if (t.type === "(") {
      at++
      const value = expr()
      if (peek().type !== ")") fail(peek())
      at++
      return value
    }
    return fail(t)
  }

  const value = expr()
  if (peek().type !== "end") fail(peek())
  return value + 0
}
`,
    },
    // Hands the text to JavaScript after a character check: ^ is XOR there and / isn't integer division
    exploit: {
      "src/expr.js": js`export function evaluate(text) {
  if (!/^[0-9+\-*/%^() ]*$/.test(text)) throw new SyntaxError("Unexpected token")
  return new Function("return (" + text + ")")()
}
`,
    },
    verify: NODE_TEST,
  },
]
