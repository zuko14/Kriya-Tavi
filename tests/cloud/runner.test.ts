import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRunner } from "@/runner"
import type { ExecEvent, Limits } from "@/runner/protocol"

import { packDirectory, tarball } from "./tar"

// The runner (track C, C2; TOOLS_AND_CONTRACTS §2, TEST_STRATEGY CT-RUN-*):
// the real service on 127.0.0.1 over a temporary directory. Commands run
// as the current user here; the switch to `kriya` is checked on the image
// (CT-ISO-07). Needs git and bash, like the browser tests need Chromium.

const hasGit = spawnSync("git", ["--version"]).status === 0
const TOKEN = "t".repeat(43)
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "cloud", "repo")
const BASE = "1".repeat(40)

type Runner = Awaited<ReturnType<typeof createRunner>> & { root: string }
const open: Runner[] = []

async function start(limits: Partial<Limits> = {}, generation = 1) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kriya-runner-")))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-home-"))
  const runner = await createRunner({
    root,
    token: TOKEN,
    generation,
    limits,
    home,
    path: process.env.PATH ?? "/usr/bin:/bin",
    killGraceMs: 200,
  })
  const r = { ...runner, root }
  open.push(r)
  return r
}

afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
})

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` })

async function post(r: Runner, route: string, body: unknown = {}, token = TOKEN) {
  const res = await fetch(`${r.url}${route}`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function exec(r: Runner, body: Record<string, unknown>, signal?: AbortSignal) {
  const res = await fetch(`${r.url}/v1/exec`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ timeoutSeconds: 30, ...body }),
    signal,
  })
  expect(res.status).toBe(200)
  const events = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExecEvent)
  const end = events.at(-1)
  if (end?.type !== "end") throw new Error("no end event")
  return { events, end }
}

async function importFixture(r: Runner) {
  const res = await fetch(`${r.url}/v1/import`, {
    method: "POST",
    headers: {
      ...auth(),
      "content-type": "application/x-tar+gzip",
      "x-kriya-strip": "1",
      "x-kriya-base": BASE,
    },
    body: new Uint8Array(packDirectory(FIXTURE)),
  })
  return { status: res.status, body: await res.json() }
}

const rawImport = (r: Runner, archive: Buffer, strip = "0") =>
  fetch(`${r.url}/v1/import`, {
    method: "POST",
    headers: {
      ...auth(),
      "content-type": "application/x-tar+gzip",
      "x-kriya-strip": strip,
    },
    body: new Uint8Array(archive),
  })

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

// Every file under root but .git and .kriya, with its bytes
function tree(root: string) {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const item of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const name = path.posix.join(rel, item.name)
      if (name === ".git" || name === ".kriya") continue
      if (item.isDirectory()) walk(name)
      else out[name] = sha256(fs.readFileSync(path.join(root, name)))
    }
  }
  walk("")
  return out
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

describe.skipIf(!hasGit)("runner", () => {
  it("CT-RUN-01: exec streams output in order and ends with the exit code", async () => {
    const r = await start()
    fs.mkdirSync(path.join(r.root, "sub"))
    const { events, end } = await exec(r, {
      command: "for i in 1 2 3; do echo $i; done; echo oops >&2; pwd; exit 3",
      cwd: "sub",
    })
    const out = events
      .filter((e) => e.type === "out" && e.stream === "stdout")
      .map((e) => (e as { text: string }).text)
      .join("")
    expect(out).toBe(`1\n2\n3\n${r.root}/sub\n`)
    expect(end).toMatchObject({
      type: "end",
      exitCode: 3,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: out,
      stderr: "oops\n",
    })
    expect(end.durationMs).toBeGreaterThanOrEqual(0)
    expect(end.logPath).toMatch(/^\.kriya\/logs\/[\w-]+\.log$/)
  })

  it("CT-RUN-02: the child gets only the allow-listed environment", async () => {
    process.env.KRIYA_RUNNER_PROBE = "runner-only"
    const r = await start()
    const { end } = await exec(r, { command: "env", env: { FOO: "bar" } })
    delete process.env.KRIYA_RUNNER_PROBE
    const names = end.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")[0])
    // A login shell's own profile adds names on some machines (Ubuntu CI:
    // SGX_AESM_ADDR, DEBUGINFOD_URLS, XDG_DATA_DIRS); those aren't the runner's
    const profile = spawnSync("bash", ["-lc", "env"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: os.tmpdir(),
        LANG: "C.UTF-8",
        TERM: "dumb",
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    })
      .stdout.trim()
      .split("\n")
      .map((line) => line.split("=")[0])
    // bash adds PWD, SHLVL, _ and OLDPWD itself
    const allowed = [
      ...profile,
      "PATH",
      "HOME",
      "LANG",
      "TERM",
      "CI",
      "FOO",
      "PWD",
      "SHLVL",
      "_",
      "OLDPWD",
    ]
    expect(names.filter((n) => !allowed.includes(n))).toEqual([])
    expect(end.stdout).toContain("FOO=bar")
    expect(end.stdout).toContain("CI=1")
    expect(end.stdout).not.toContain(TOKEN)
    expect(end.stdout).not.toContain("runner-only")
    for (const env of [
      { PATH: "/x" },
      { HOME: "/x" },
      { LD_PRELOAD: "/x" },
      { lower: "x" },
    ]) {
      const res = await post(r, "/v1/exec", { command: "true", timeoutSeconds: 5, env })
      expect(res.status, JSON.stringify(env)).toBe(400)
    }
  })

  it("CT-RUN-03: output over the cap comes back as head + tail with the full log", async () => {
    const r = await start()
    const { events, end } = await exec(r, {
      command: "head -c 200000 /dev/zero | tr '\\0' a; echo; echo last",
    })
    expect(end.truncated).toBe(true)
    expect(end.stdout.startsWith("a".repeat(8192))).toBe(true)
    expect(end.stdout).toContain("[output truncated")
    expect(end.stdout.endsWith("last\n")).toBe(true)
    expect(end.stdout.length).toBeLessThan(17_000)
    const streamed = events
      .filter((e) => e.type === "out")
      .reduce((n, e) => n + (e as { text: string }).text.length, 0)
    expect(streamed).toBeLessThanOrEqual(64 * 1024)
    const log = fs.readFileSync(path.join(r.root, end.logPath), "utf8")
    expect(log).toBe(`${"a".repeat(200000)}\nlast\n`)
  })

  it("CT-RUN-04: a timeout kills the whole process group", async () => {
    const r = await start()
    const { end } = await exec(r, {
      command: "sleep 1000 & echo $! > grand.pid; wait",
      timeoutSeconds: 1,
    })
    expect(end).toMatchObject({ timedOut: true, exitCode: null })
    const pid = Number(fs.readFileSync(path.join(r.root, "grand.pid"), "utf8"))
    expect(await until(() => !alive(pid))).toBe(true)
  })

  it("CT-RUN-05: a client disconnect kills the whole process group", async () => {
    const r = await start()
    const abort = new AbortController()
    const pending = exec(
      r,
      { command: "sleep 1000 & echo $! > g.pid; wait" },
      abort.signal
    )
    const pidFile = path.join(r.root, "g.pid")
    expect(
      await until(
        () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== ""
      )
    ).toBe(true)
    const pid = Number(fs.readFileSync(pidFile, "utf8"))
    abort.abort()
    await pending.catch(() => {})
    expect(await until(() => !alive(pid))).toBe(true)
  })

  it("CT-RUN-06: writes and edits need a fresh read (P4)", async () => {
    const r = await start()
    // A new file needs no read
    expect(await post(r, "/v1/write", { path: "a.txt", content: "1\n" })).toMatchObject({
      status: 200,
      body: { created: true },
    })
    // Its own write counts as seen
    expect((await post(r, "/v1/write", { path: "a.txt", content: "2\n" })).status).toBe(
      200
    )

    await exec(r, { command: "echo x > b.txt" })
    const unread = await post(r, "/v1/write", { path: "b.txt", content: "y\n" })
    expect(unread.status).toBe(409)
    expect(unread.body.error).toMatch(/read it first/)
    const read = await post(r, "/v1/read", { path: "b.txt" })
    expect(read.body).toMatchObject({ text: "x\n", lines: 1, sha256: sha256("x\n") })
    expect(
      (await post(r, "/v1/edit", { path: "b.txt", oldText: "x", newText: "z" })).status
    ).toBe(200)

    await exec(r, { command: "echo more >> b.txt" })
    const stale = await post(r, "/v1/edit", { path: "b.txt", oldText: "z", newText: "q" })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/read it again/)

    // A read of a missing path counts: a file that appears later is stale
    expect((await post(r, "/v1/read", { path: "c.txt" })).status).toBe(404)
    await exec(r, { command: "echo outside > c.txt" })
    expect((await post(r, "/v1/write", { path: "c.txt", content: "mine" })).status).toBe(
      409
    )

    // expectSha256 must match what's on disk
    await post(r, "/v1/read", { path: "a.txt" })
    const wrong = await post(r, "/v1/write", {
      path: "a.txt",
      content: "3\n",
      expectSha256: "0".repeat(64),
    })
    expect(wrong.status).toBe(409)
  })

  it("CT-RUN-07: edit needs exactly one match unless replaceAll", async () => {
    const r = await start()
    await post(r, "/v1/write", { path: "e.txt", content: "foo foo bar\n" })
    const none = await post(r, "/v1/edit", {
      path: "e.txt",
      oldText: "baz",
      newText: "x",
    })
    expect(none.status).toBe(422)
    expect(none.body.error).toMatch(/not found/)
    const two = await post(r, "/v1/edit", { path: "e.txt", oldText: "foo", newText: "x" })
    expect(two.status).toBe(422)
    expect(two.body.error).toMatch(/2 matches/)
    const all = await post(r, "/v1/edit", {
      path: "e.txt",
      oldText: "foo",
      newText: "x",
      replaceAll: true,
    })
    expect(all.body).toMatchObject({ replacements: 2 })
    expect(fs.readFileSync(path.join(r.root, "e.txt"), "utf8")).toBe("x x bar\n")
  })

  it("CT-RUN-08: patch adds, updates and deletes, all or nothing (P3)", async () => {
    const r = await start()
    await post(r, "/v1/write", { path: "x.txt", content: "a\nb\nc\n" })
    await post(r, "/v1/write", { path: "gone.txt", content: "z\n" })
    const ok = await post(r, "/v1/patch", {
      patch: [
        "*** Begin Patch",
        "*** Add File: new/n.txt",
        "+hello",
        "*** Update File: x.txt",
        "@@",
        " a",
        "-b",
        "+B",
        " c",
        "*** Delete File: gone.txt",
        "*** End Patch",
      ].join("\n"),
    })
    expect(ok).toMatchObject({
      status: 200,
      body: {
        files: [
          { path: "new/n.txt", op: "add" },
          { path: "x.txt", op: "update" },
          { path: "gone.txt", op: "delete" },
        ],
      },
    })
    expect(fs.readFileSync(path.join(r.root, "new/n.txt"), "utf8")).toBe("hello\n")
    expect(fs.readFileSync(path.join(r.root, "x.txt"), "utf8")).toBe("a\nB\nc\n")
    expect(fs.existsSync(path.join(r.root, "gone.txt"))).toBe(false)

    const bad = await post(r, "/v1/patch", {
      patch: [
        "*** Begin Patch",
        "*** Add File: p.txt",
        "+p",
        "*** Update File: x.txt",
        "@@",
        "-nope",
        "+yes",
        "*** End Patch",
      ].join("\n"),
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toMatch(/x\.txt/)
    expect(fs.existsSync(path.join(r.root, "p.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(r.root, "x.txt"), "utf8")).toBe("a\nB\nc\n")

    // P4 holds per touched file
    await exec(r, { command: "echo q > q.txt" })
    const unread = await post(r, "/v1/patch", {
      patch: "*** Begin Patch\n*** Delete File: q.txt\n*** End Patch",
    })
    expect(unread.status).toBe(409)
    expect((await post(r, "/v1/patch", { patch: "not a patch" })).status).toBe(422)
  })

  it("CT-RUN-09: search caps matches and line length and honours .gitignore", async () => {
    const r = await start({ searchMatches: 2, searchLineChars: 50 })
    await post(r, "/v1/write", { path: ".gitignore", content: "*.log\n" })
    await post(r, "/v1/write", {
      path: "a.txt",
      content: "needle 1\nneedle 2\nneedle 3\n",
    })
    await post(r, "/v1/write", {
      path: "sub/b.md",
      content: `needle ${"x".repeat(500)}\n`,
    })
    await post(r, "/v1/write", { path: "skip.log", content: "needle\n" })
    const capped = await post(r, "/v1/search", { pattern: "needle" })
    expect(capped.body.truncated).toBe(true)
    expect(capped.body.matches).toHaveLength(2)

    const wide = await start({ searchLineChars: 50 })
    await post(wide, "/v1/write", { path: ".gitignore", content: "*.log\n" })
    await post(wide, "/v1/write", { path: "a.txt", content: "needle 1\na.c\nabc\n" })
    await post(wide, "/v1/write", {
      path: "sub/b.md",
      content: `needle ${"x".repeat(500)}\n`,
    })
    await post(wide, "/v1/write", { path: "skip.log", content: "needle\n" })
    const all = await post(wide, "/v1/search", { pattern: "needle" })
    expect(all.body.truncated).toBe(false)
    expect(all.body.matches.map((m: { path: string }) => m.path).sort()).toEqual([
      "a.txt",
      "sub/b.md",
    ])
    for (const m of all.body.matches) expect(m.text.length).toBeLessThanOrEqual(51)
    const inSub = await post(wide, "/v1/search", { pattern: "needle", path: "sub" })
    expect(inSub.body.matches).toEqual([
      { path: "sub/b.md", line: 1, text: expect.stringMatching(/^needle x+…$/) },
    ])
    const globbed = await post(wide, "/v1/search", { pattern: "needle", glob: "*.txt" })
    expect(globbed.body.matches).toEqual([{ path: "a.txt", line: 1, text: "needle 1" }])
    const fixed = await post(wide, "/v1/search", { pattern: "a.c", fixed: true })
    expect(fixed.body.matches).toEqual([{ path: "a.txt", line: 2, text: "a.c" }])
    const regex = await post(wide, "/v1/search", { pattern: "a.c" })
    expect(regex.body.matches).toHaveLength(2)
    // list honours .gitignore too
    const list = await post(wide, "/v1/list", {})
    expect(list.body.entries.map((e: { path: string }) => e.path).sort()).toEqual([
      ".gitignore",
      "a.txt",
      "sub",
      "sub/b.md",
    ])
  })

  it("CT-RUN-10: changes lists files with counts and a stable change set id", async () => {
    const r = await start()
    expect((await importFixture(r)).status).toBe(200)
    await post(r, "/v1/read", { path: "src/math.js" })
    await post(r, "/v1/edit", {
      path: "src/math.js",
      oldText: "multiply(a, b) {\n  return a + b",
      newText: "multiply(a, b) {\n  return a * b",
    })
    await post(r, "/v1/write", { path: "new.txt", content: "one\ntwo\n" })
    await exec(r, {
      command:
        "rm src/greet.js && printf 'a\\0b' > bin.dat && mkdir -p dist && echo x > dist/out.js",
    })
    const first = await post(r, "/v1/changes", {})
    expect(first.status).toBe(200)
    const byPath = Object.fromEntries(
      first.body.files.map((f: { path: string }) => [f.path, f])
    )
    expect(Object.keys(byPath).sort()).toEqual([
      "bin.dat",
      "new.txt",
      "src/greet.js",
      "src/math.js",
    ])
    expect(byPath["src/math.js"]).toMatchObject({
      status: "modified",
      added: 1,
      removed: 1,
      binary: false,
    })
    expect(byPath["new.txt"]).toMatchObject({ status: "added", added: 2, removed: 0 })
    expect(byPath["src/greet.js"]).toMatchObject({
      status: "deleted",
      added: 0,
      removed: 3,
    })
    expect(byPath["bin.dat"]).toMatchObject({ status: "added", binary: true, bytes: 3 })
    expect(first.body.diff).toContain("+  return a * b")
    expect(first.body.changeSetId).toMatch(/^[0-9a-f]{64}$/)

    expect((await post(r, "/v1/changes", {})).body.changeSetId).toBe(
      first.body.changeSetId
    )
    await exec(r, { command: "printf '!' >> new.txt" })
    expect((await post(r, "/v1/changes", {})).body.changeSetId).not.toBe(
      first.body.changeSetId
    )
  })

  it("CT-RUN-11: every route but health needs the token", async () => {
    const r = await start()
    const routes = [
      "/v1/import",
      "/v1/restore",
      "/v1/exec",
      "/v1/read",
      "/v1/write",
      "/v1/edit",
      "/v1/patch",
      "/v1/list",
      "/v1/search",
      "/v1/changes",
      "/v1/files",
      "/v1/checkpoint",
    ]
    for (const route of routes) {
      const none = await fetch(`${r.url}${route}`, { method: "POST", body: "{}" })
      expect(none.status, route).toBe(401)
      expect((await post(r, route, {}, "wrong")).status, route).toBe(401)
    }
    expect((await fetch(`${r.url}/v1/health`)).status).toBe(200)
  })

  it("CT-RUN-12: paths stay inside the workspace; .kriya is read-only", async () => {
    const r = await start()
    for (const p of ["../x", "/etc/hosts", "a/../../x"]) {
      expect((await post(r, "/v1/read", { path: p })).status, p).toBe(403)
      expect((await post(r, "/v1/write", { path: p, content: "x" })).status, p).toBe(403)
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-outside-"))
    fs.writeFileSync(path.join(outside, "secret.txt"), "no")
    fs.symlinkSync(outside, path.join(r.root, "link"))
    expect((await post(r, "/v1/read", { path: "link/secret.txt" })).status).toBe(403)
    expect(
      (await post(r, "/v1/write", { path: "link/new.txt", content: "x" })).status
    ).toBe(403)
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false)
    expect((await post(r, "/v1/write", { path: ".kriya/x", content: "x" })).status).toBe(
      403
    )
    expect((await post(r, "/v1/list", { path: "../" })).status).toBe(403)
    expect(
      (await post(r, "/v1/exec", { command: "pwd", cwd: "../", timeoutSeconds: 5 }))
        .status
    ).toBe(403)
  })

  it("CT-RUN-13: oversized bodies and unknown fields are refused", async () => {
    const r = await start({ bodyBytes: 1024 })
    expect(
      (await post(r, "/v1/write", { path: "a", content: "x".repeat(2048) })).status
    ).toBe(413)
    expect((await post(r, "/v1/read", { path: "a", extra: 1 })).status).toBe(400)
    expect((await post(r, "/v1/exec", { command: "true" })).status).toBe(400)
    const bad = await fetch(`${r.url}/v1/read`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: "{not json",
    })
    expect(bad.status).toBe(400)
  })

  it("CT-RUN-14: import refuses hostile archives before extracting anything", async () => {
    const r = await start({ importFiles: 3, importBytes: 4096 })
    const cases = [
      [{ name: "/etc/x", content: "x" }],
      [{ name: "../x", content: "x" }],
      [{ name: "a/../../x", content: "x" }],
      [{ name: "l", type: "symlink" as const, linkname: "../../etc" }],
      [{ name: "l", type: "symlink" as const, linkname: "/etc" }],
      [{ name: "h", type: "hardlink" as const, linkname: "a" }],
      [{ name: "dev", type: "char" as const }],
      [{ name: ".git/config", content: "x" }],
      [{ name: ".kriya/x", content: "x" }],
      [1, 2, 3, 4].map((n) => ({ name: `f${n}`, content: "x" })),
      [{ name: "big", content: "x".repeat(5000) }],
    ]
    for (const entries of cases) {
      // A harmless file first proves nothing is written before the check
      const res = await rawImport(
        r,
        tarball([{ name: "ok.txt", content: "fine" }, ...entries])
      )
      expect([400, 413], JSON.stringify(entries[0])).toContain(res.status)
      expect(fs.readdirSync(r.root).filter((n) => n !== ".kriya")).toEqual([])
    }
    expect((await rawImport(r, Buffer.from("not gzip"))).status).toBe(400)
  })

  it("CT-RUN-15: import creates the base commit once per generation", async () => {
    const r = await start()
    const first = await importFixture(r)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      files: 5,
      baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(first.body.bytes).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(r.root, "src", "math.js"))).toBe(true)
    const { end } = await exec(r, {
      command: "git log --format=%s | wc -l; git log -1 --format=%B",
    })
    expect(end.stdout).toMatch(/^\s*1\n/)
    expect(end.stdout).toContain(BASE)
    expect(fs.existsSync(path.join(r.root, "owner-repo-0123456"))).toBe(false)
    expect((await importFixture(r)).status).toBe(409)
  })

  it("CT-RUN-16: checkpoint then restore in a fresh runner reproduces the tree", async () => {
    const r = await start()
    await importFixture(r)
    await exec(r, {
      command: [
        "printf 'export const x = 1\\n' >> src/math.js",
        "rm src/greet.js",
        "printf 'new\\n' > untracked.txt",
        "printf '\\0\\1\\2' > blob.bin",
        "chmod +x untracked.txt",
        "mkdir -p dist && echo ignored > dist/out.js",
      ].join(" && "),
    })
    const res = await fetch(`${r.url}/v1/checkpoint`, { method: "POST", headers: auth() })
    expect(res.status).toBe(200)
    const patch = Buffer.from(await res.arrayBuffer())
    expect(res.headers.get("x-kriya-sha256")).toBe(sha256(patch))
    expect(JSON.parse(res.headers.get("x-kriya-changes") ?? "{}")).toMatchObject({
      files: 4,
    })

    const expected = tree(r.root)
    delete expected["dist/out.js"]

    const fresh = await start({}, 2)
    await importFixture(fresh)
    const restored = await fetch(`${fresh.url}/v1/restore`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/octet-stream" },
      body: new Uint8Array(patch),
    })
    expect(await restored.json()).toEqual({ applied: true })
    expect(tree(fresh.root)).toEqual(expected)
    expect(fs.statSync(path.join(fresh.root, "untracked.txt")).mode & 0o111).not.toBe(0)

    // A patch that doesn't apply leaves the tree at base and says so
    const other = await start({}, 3)
    await importFixture(other)
    const before = tree(other.root)
    const failed = await fetch(`${other.url}/v1/restore`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/octet-stream" },
      body: "diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-a\n+b\n",
    })
    expect(failed.status).toBe(422)
    expect(tree(other.root)).toEqual(before)
  })

  it("CT-RUN-17: a checkpoint over the cap is refused with a reason", async () => {
    const r = await start({ checkpointBytes: 1024 })
    await importFixture(r)
    await post(r, "/v1/write", { path: "big.txt", content: "y\n".repeat(4000) })
    const res = await fetch(`${r.url}/v1/checkpoint`, { method: "POST", headers: auth() })
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/checkpoint is larger than/)
  })

  it("CT-RUN-18: files returns the change set's contents and refuses a stale id", async () => {
    const r = await start()
    await importFixture(r)
    await exec(r, {
      command: "rm src/greet.js && printf '#!/bin/sh\\n' > run.sh && chmod +x run.sh",
    })
    const { body } = await post(r, "/v1/changes", {})
    const files = await post(r, "/v1/files", { changeSetId: body.changeSetId })
    expect(files.status).toBe(200)
    expect(files.body.files).toEqual([
      {
        path: "run.sh",
        status: "added",
        mode: "100755",
        contentBase64: Buffer.from("#!/bin/sh\n").toString("base64"),
      },
      { path: "src/greet.js", status: "deleted", mode: "100644" },
    ])
    await exec(r, { command: "echo more >> run.sh" })
    expect((await post(r, "/v1/files", { changeSetId: body.changeSetId })).status).toBe(
      409
    )
  })

  it("CT-RUN-19: health answers without a token and says nothing about the workspace", async () => {
    const r = await start({}, 7)
    await post(r, "/v1/write", { path: "private.txt", content: "x" })
    const res = await fetch(`${r.url}/v1/health`)
    const body = await res.json()
    expect(body).toEqual({ ok: true, version: expect.any(String), generation: 7 })
    expect(JSON.stringify(body)).not.toContain("private")
  })
})
