import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import postgres from "postgres"

// ED14's browser check, isolated stack only (operator rule 7): plays the computer on
// the real device routes for a person signed up in the browser pane. It holds no
// service key and signs nobody in; the rows it adds are local test rows.
//
//   node scripts/verify-ed14.mjs setup <email>      a device, an agent, plan room, the bucket
//   node scripts/verify-ed14.mjs claim <email>      takes the edit, reports 40%
//   node scripts/verify-ed14.mjs finish <email>     uploads a real file, reports done
//   node scripts/verify-ed14.mjs restore <email>

const APP_URL = "http://127.0.0.1:6796"
const DEVICE = "e1400000-0000-4000-8000-000000000001"
const PROJECT = "0e14000000000001"
const AGENT = "ed14-editor"
const STATE = path.join(os.tmpdir(), "kriya-ed14-device.json")

if (!process.env.DATABASE_URL?.includes("127.0.0.1"))
  throw new Error("Export .env.verify (local stack) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const [action, email] = process.argv.slice(2)
const [user] = await sql`select id from auth.users where email = ${email}`
if (!user) throw new Error("Sign that person up in the browser pane first")

async function route(method, url, body) {
  const { token } = JSON.parse(fs.readFileSync(STATE, "utf8"))
  const res = await fetch(`${APP_URL}/api/harness/v1${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-kriya-harness": "0.3.0",
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  })
  if (res.status >= 400) throw new Error(`${method} ${url} answered ${res.status}`)
  return res.status === 204 ? null : res.json()
}

const hello = () =>
  route("POST", "/daemon/hello", {
    daemonVersion: "0.3.0",
    capabilities: { fullAccess: false, serve: false, handoff: true, edit: true },
    projects: [{ id: PROJECT, name: "Raw footage", path: "~/Raw footage", git: false }],
    rules: [],
  })

const steps = {
  async setup() {
    const token = randomBytes(32).toString("base64url")
    const hash = createHash("sha256").update(token).digest("hex")
    fs.writeFileSync(STATE, JSON.stringify({ token }), { mode: 0o600 })
    await sql`insert into kriya.harness_devices (id, user_id, name, platform, token_hash)
      values (${DEVICE}, ${user.id}, 'Studio MacBook', 'darwin', ${hash})
      on conflict (id) do update set token_hash = ${hash}, revoked_at = null, user_id = ${user.id}`
    await sql`insert into kriya.agents (id, user_id, name, role, glyph)
      values (${AGENT}, ${user.id}, 'Reel editor', 'Video editor', 'g-attach')
      on conflict do nothing`
    await sql`update kriya.plans set editing_preview_bytes = 104857600`
    await sql`insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('kriya-edit-previews', 'kriya-edit-previews', false, 47185920,
              ${["video/mp4", "image/png", "image/jpeg", "application/json"]})
      on conflict (id) do nothing`
    await hello()
    console.log("setup: device says hello, agent ready at /a/ed14-editor")
  },

  async claim() {
    await hello()
    const next = await route("GET", "/dispatch/next?wait=0")
    if (next.dispatch?.kind !== "edit") throw new Error("no edit to claim")
    const state = {
      ...JSON.parse(fs.readFileSync(STATE, "utf8")),
      dispatch: next.dispatch.id,
      job: next.dispatch.payload.job,
    }
    fs.writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 })
    await route("POST", `/dispatch/${state.dispatch}`, { status: "running" })
    await route("POST", `/dispatch/${state.dispatch}`, {
      status: "running",
      result: { stage: "editing", percent: 40, beat: 1 },
    })
    console.log(
      `claimed: payload keys ${Object.keys(next.dispatch.payload).sort().join(", ")}`
    )
  },

  async finish() {
    const { dispatch, job } = JSON.parse(fs.readFileSync(STATE, "utf8"))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ed14-"))
    const file = path.join(dir, "preview.mp4")
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=15:d=2",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      file,
    ])
    const bytes = fs.readFileSync(file)
    const reserved = await route("POST", `/editing/jobs/${job}/previews`, {
      kind: "preview",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
    const put = await fetch(reserved.uploadUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "video/mp4" },
    })
    if (!put.ok) throw new Error(`upload answered ${put.status}`)
    await route("POST", `/editing/jobs/${job}/previews/${reserved.id}`)
    await route("POST", `/dispatch/${dispatch}`, {
      status: "done",
      result: {
        outcome: "delivered_with_notes",
        gates: [{ gate: "QG-01", level: "pass" }],
        notes: 2,
      },
    })
    console.log(`finished: uploaded ${bytes.length} bytes, preview ${reserved.id}`)
  },

  // ED15: a decision card from the running job, and a new recording
  async card() {
    await hello()
    const { job } = JSON.parse(fs.readFileSync(STATE, "utf8"))
    const made = await route("POST", `/editing/jobs/${job}/questions`, {
      kind: "file",
      prompt: "Which recording did you mean?",
      options: [{ label: "Tuesday talk.mov" }, { label: "Tuesday talk take 2.mov" }],
      defaultOption: 0,
      timeoutSeconds: 3600,
    })
    console.log(`card: ${made.id}`)
    await route("POST", "/editing/found", {
      project: PROJECT,
      name: "Sunday podcast.mov",
      seconds: 2040,
    })
    console.log("found: told Kriya of one new recording")
  },
  async answer() {
    const [row] =
      await sql`select id from kriya.edit_questions where kind = 'file' order by created_at desc limit 1`
    console.log(
      "answer as the computer sees it:",
      await route("GET", `/editing/questions/${row.id}?wait=0`)
    )
  },
  async notes() {
    const { job } = JSON.parse(fs.readFileSync(STATE, "utf8"))
    console.log(
      "notes as the computer sees them:",
      JSON.stringify(await route("GET", `/editing/jobs/${job}/notes`))
    )
  },

  async restore() {
    await sql`delete from kriya.harness_devices where id = ${DEVICE}`
    await sql`delete from kriya.agents where id = ${AGENT}`
    await sql`update kriya.plans set editing_preview_bytes = 0`
    fs.rmSync(STATE, { force: true })
    console.log("restore: local test rows removed")
  },
}

await steps[action]()
await sql.end()
