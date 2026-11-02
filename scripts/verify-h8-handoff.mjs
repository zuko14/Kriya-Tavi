import { execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"

// H8 check on the isolated P-3 stack only: the real Kriya Harness client
// (../kriya-harness) runs `kriya handoff` in a git repository against the
// local Kriya server; the patch must land in local Storage at
// workspaces/<user>/<workspace>/0-1.patch with its sha256, beside a
// workspaces row, a thread of the device's agent and one queued task. Then
// `kriya pull` in a second clone must restore the same files on
// kriya/pull-<id>. "GitHub" is a local bare repository whose clones name
// github.com as origin; nothing leaves this machine. The worker's restore
// in a sandbox is covered by tests/harness/handoff.test.ts (real runner).
//
//   node scripts/verify-h8-handoff.mjs setup     (before starting web-verify)
//   node scripts/verify-h8-handoff.mjs run
//   node scripts/verify-h8-handoff.mjs restore
//
// `setup` writes local test values only, each removed by `restore`:
// harness.handoff, cloud.workspaces on, cloud.provider local, the local
// free plan's workspace minutes, a placeholder GitHub connection row for
// Asha (no real token: nothing here calls GitHub). `run` adds a worker
// heartbeat row for the length of the check (no worker runs: the queued
// task is canceled by `restore`, never executed).

const SUPABASE_URL = "http://127.0.0.1:54321"
const APP_URL = "http://127.0.0.1:6796"
const CLIENT = path.resolve(process.cwd(), "..", "kriya-harness")
const EMAIL = "asha@example.com"
const DEVICE = "verify-handoff-laptop"
const WORKER = "verify-h8-heartbeat"
const KEYS = ["harness.handoff", "cloud.workspaces", "cloud.provider"]
const OUT = path.join(process.cwd(), "screenshots", "kriya-harness", "H8")

if (
  !process.env.SUPABASE_SECRET_KEY ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !process.env.DATABASE_URL?.includes("127.0.0.1")
)
  throw new Error("Export .env.verify (local stack) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const SAVED = path.join(os.tmpdir(), "kriya-h8-saved.json")

const userId = async () =>
  (await sql`select id from auth.users where email = ${EMAIL}`)[0].id

async function setup() {
  // A second setup would save the test values as the originals
  if (fs.existsSync(SAVED)) throw new Error("setup already ran; run restore first")
  const user = await userId()
  const [free] = await sql`select workspace_minutes from kriya.plans where id = 'free'`
  const settings =
    await sql`select key, value from kriya.platform_settings where key in ${sql(KEYS)}`
  const [github] =
    await sql`select id from kriya.connections where user_id = ${user} and provider = 'github'`
  fs.writeFileSync(SAVED, JSON.stringify({ free, settings, github: Boolean(github) }))
  await sql`insert into kriya.platform_settings (key, value)
    values ('harness.handoff', 'on'), ('cloud.workspaces', 'on'), ('cloud.provider', 'local')
    on conflict (key) do update set value = excluded.value`
  await sql`update kriya.plans set workspace_minutes = 60 where id = 'free'`
  if (!github)
    await sql`insert into kriya.connections (id, user_id, provider, scopes, access_token)
      values ('verify-h8-github', ${user}, 'github', '{}', 'placeholder-not-a-token')`
  // The private bucket, as O5 made it on this stack (no migration creates it;
  // it stays, like O5's)
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).storage
  if ((await admin.getBucket("kriya-files")).error) {
    const made = await admin.createBucket("kriya-files", { public: false })
    if (made.error) throw made.error
    console.log("setup: private bucket kriya-files created on the local stack")
  }
  console.log("setup: local test values written; start web-verify now")
}

async function restore() {
  const saved = JSON.parse(fs.readFileSync(SAVED, "utf8"))
  const user = await userId()
  const rows =
    await sql`select w.id, w.thread_id, w.checkpoint_path from kriya.workspaces w
      join kriya.threads t on t.id = w.thread_id and t.user_id = w.user_id
      join kriya.harness_devices d on d.user_id = w.user_id and d.name = ${DEVICE}
      where w.user_id = ${user} and t.title like 'Handoff · %'`
  const store = storage()
  for (const row of rows) {
    await sql`update kriya.tasks set status = 'canceled' where thread_id = ${row.thread_id} and status in ('queued', 'running')`
    if (row.checkpoint_path) await store.remove([row.checkpoint_path])
    await sql`delete from kriya.resource_usage where request_key = ${`workspace-ckpt:${row.id}:0-1`}`
    await sql`delete from kriya.workspaces where id = ${row.id}`
    await sql`delete from kriya.threads where id = ${row.thread_id}`
  }
  await sql`update kriya.plans set workspace_minutes = ${saved.free.workspace_minutes} where id = 'free'`
  await sql`delete from kriya.platform_settings where key in ${sql(KEYS)}`
  for (const row of saved.settings)
    await sql`insert into kriya.platform_settings (key, value) values (${row.key}, ${row.value})`
  if (!saved.github)
    await sql`delete from kriya.connections where id = 'verify-h8-github'`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  await sql`delete from kriya.workers where id = ${WORKER}`
  fs.rmSync(SAVED)
  console.log(`restore: local test values removed (${rows.length} handoff(s) cleaned up)`)
}

const storage = () =>
  createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).storage.from("kriya-files")

async function device(home) {
  const user = await userId()
  const [agent] =
    await sql`select id from kriya.agents where user_id = ${user} order by created_at limit 1`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  const token = randomBytes(32).toString("base64url")
  const [row] = await sql`insert into kriya.harness_devices
      (user_id, agent_id, name, platform, token_hash)
    values (${user}, ${agent.id}, ${DEVICE}, 'darwin',
      ${createHash("sha256").update(token).digest("hex")}) returning id`
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(home, "device.json"),
    JSON.stringify({ url: APP_URL, token, deviceId: row.id }),
    { mode: 0o600 }
  )
  return { user, agentId: agent.id }
}

const ID = {
  GIT_AUTHOR_NAME: "Verify",
  GIT_AUTHOR_EMAIL: "verify@example.com",
  GIT_COMMITTER_NAME: "Verify",
  GIT_COMMITTER_EMAIL: "verify@example.com",
}
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...ID },
  }).trim()
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

function kriya(home, cwd, args) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [path.join(CLIENT, "bin", "kriya.js"), ...args],
      {
        cwd,
        env: { ...process.env, ...ID, KRIYA_HOME: home },
      }
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("exit", (code) => (clearTimeout(timer), done({ code, stdout, stderr })))
  })
}

async function run() {
  const home = temp("kriya-h8-home-")
  const { user, agentId } = await device(home)
  // "GitHub": a bare repository with the base commit; clones name github.com
  const origin = temp("kriya-h8-origin-")
  git(origin, "init", "--quiet", "--bare", "-b", "main")
  const seed = temp("kriya-h8-seed-")
  git(seed, "init", "--quiet", "-b", "main")
  fs.writeFileSync(
    path.join(seed, "math.js"),
    "export const multiply = (a, b) => a + b\n"
  )
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "base")
  git(seed, "push", "--quiet", origin, "main")
  const clone = () => {
    const dir = temp("kriya-h8-clone-")
    git(dir, "clone", "--quiet", origin, ".")
    git(dir, "remote", "set-url", "origin", "https://github.com/asha/calc.git")
    return dir
  }
  const laptop = clone()
  const base = git(laptop, "rev-parse", "HEAD")
  fs.writeFileSync(
    path.join(laptop, "math.js"),
    "export const multiply = (a, b) => a * b\n"
  )
  fs.writeFileSync(path.join(laptop, "notes.md"), "# Next\n- finish the tests\n")
  fs.writeFileSync(path.join(laptop, "logo.bin"), Buffer.from([0, 1, 2, 255, 254, 0]))

  await sql`insert into kriya.workers (id, version, concurrency) values (${WORKER}, 'verify', 1)
    on conflict (id) do update set heartbeat_at = now(), stopped_at = null`
  const sent = await kriya(home, laptop, ["handoff", "Finish the tests in the cloud"])
  console.log(sent.stdout.trim(), sent.stderr.trim())
  await sql`update kriya.workers set stopped_at = now() where id = ${WORKER}`
  if (sent.code !== 0) throw new Error(`kriya handoff exited ${sent.code}`)
  const workspaceId = /Workspace ([0-9a-f-]{36})/.exec(sent.stdout)[1]

  const [row] =
    await sql`select user_id, thread_id, agent_id, repo, base_ref, base_sha, provider,
      status, checkpoint_path, checkpoint_sha256, checkpoint_bytes::int as checkpoint_bytes, checkpoint_seq
    from kriya.workspaces where id = ${workspaceId}`
  const tasks =
    await sql`select status from kriya.tasks where thread_id = ${row.thread_id}`
  const blob = await storage().download(row.checkpoint_path)
  if (blob.error) throw blob.error
  const stored = Buffer.from(await blob.data.arrayBuffer())
  const storedSha = createHash("sha256").update(stored).digest("hex")

  const other = clone()
  const got = await kriya(home, other, ["pull"])
  console.log(got.stdout.trim(), got.stderr.trim())
  const same = ["math.js", "notes.md", "logo.bin"].map((file) => ({
    file,
    equal: fs
      .readFileSync(path.join(other, file))
      .equals(fs.readFileSync(path.join(laptop, file))),
  }))

  const result = {
    handoffExit: sent.code,
    pullExit: got.code,
    workspace: { ...row, user: row.user_id === user, agent: row.agent_id === agentId },
    expectedPath: `workspaces/${user}/${workspaceId}/0-1.patch`,
    storedBytes: stored.length,
    storedShaMatchesRow: storedSha === row.checkpoint_sha256,
    baseShaMatches: row.base_sha === base,
    tasks: tasks.map((t) => t.status),
    pulledBranch: git(other, "branch", "--show-current"),
    pulledAtBase: git(other, "rev-parse", "HEAD") === base,
    filesEqual: same,
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result, null, 2))
  const ok =
    result.handoffExit === 0 &&
    result.pullExit === 0 &&
    row.checkpoint_path === result.expectedPath &&
    result.storedShaMatchesRow &&
    result.baseShaMatches &&
    result.tasks.length === 1 &&
    result.tasks[0] === "queued" &&
    result.pulledBranch === `kriya/pull-${workspaceId}` &&
    result.pulledAtBase &&
    same.every((f) => f.equal)
  console.log(ok ? "H8 end-to-end: PASS" : "H8 end-to-end: FAIL")
  if (!ok) process.exitCode = 1
}

const step = { setup, run, restore }[process.argv[2]]
if (!step) throw new Error("usage: verify-h8-handoff.mjs setup|run|restore")
await step().finally(() => sql.end())
