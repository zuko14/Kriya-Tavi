import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import postgres from "postgres"

// H11 check on the isolated P-3 stack only: the real Kriya Harness client
// (../kriya-harness) runs `kriya acp` on the pinned DSH, driven by a
// minimal ACP v1 client the way an editor drives it (initialize,
// session/new, session/prompt over stdin/stdout). The model call must go
// through the local Kriya gateway (a harness_usage row for the device) to
// the scripted stub upstream on :6797, and its answer must come back as an
// ACP agent message. No money, no provider, no editor installed.
//
//   node scripts/verify-h11-acp.mjs setup     (before starting web-verify)
//   node scripts/verify-h11-acp.mjs run
//   node scripts/verify-h11-acp.mjs restore
//
// `setup` writes H7's local test values, each removed by `restore`:
// harness.gateway on, an exchange rate of 1 and a 1 micro-USD price for the
// non-existent model stub/budget (fixtures, never real prices), the local
// free plan's harness limit and balanced tier.

const APP_URL = "http://127.0.0.1:6796"
const CLIENT = path.resolve(process.cwd(), "..", "kriya-harness")
const OUT = path.join(process.cwd(), "screenshots", "kriya-harness", "H11")
const EMAIL = "asha@example.com"
const DEVICE = "verify-acp-laptop"
const ANSWER = "Hello from the local Kriya gateway over ACP."
const STUB_MODEL = "stub/budget"
const KEYS = ["harness.gateway", "fx.usdInr"]

if (
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !process.env.DATABASE_URL?.includes("127.0.0.1") ||
  !process.env.OPENROUTER_BASE_URL?.includes("127.0.0.1:6797")
)
  throw new Error("Export .env.verify (local stack, local stub) first")

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const SAVED = path.join(os.tmpdir(), "kriya-h11-saved.json")

async function setup() {
  // A second setup would save the test values as the originals
  if (fs.existsSync(SAVED)) throw new Error("setup already ran; run restore first")
  const [free] =
    await sql`select allowed_tiers, harness_monthly_micro_inr from kriya.plans where id = 'free'`
  const settings =
    await sql`select key, value from kriya.platform_settings where key in ${sql(KEYS)}`
  const [model] = await sql`select id from kriya.models where id = ${STUB_MODEL}`
  fs.writeFileSync(SAVED, JSON.stringify({ free, settings, model: Boolean(model) }))
  await sql`insert into kriya.platform_settings (key, value)
    values ('harness.gateway', 'on'), ('fx.usdInr', '1')
    on conflict (key) do update set value = excluded.value`
  await sql`update kriya.plans set allowed_tiers = array['budget', 'balanced'],
    harness_monthly_micro_inr = 500000000 where id = 'free'`
  await sql`insert into kriya.models (id, label, enabled, supports_tools,
      input_micro_usd_per_mtok, output_micro_usd_per_mtok)
    values (${STUB_MODEL}, 'Local stub (verification only)', true, true, 1, 1)
    on conflict (id) do nothing`
  console.log("setup: local test values written; start web-verify now")
}

async function restore() {
  const saved = JSON.parse(fs.readFileSync(SAVED, "utf8"))
  await sql`update kriya.plans set allowed_tiers = ${saved.free.allowed_tiers},
    harness_monthly_micro_inr = ${saved.free.harness_monthly_micro_inr} where id = 'free'`
  await sql`delete from kriya.platform_settings where key in ${sql(KEYS)}`
  for (const row of saved.settings)
    await sql`insert into kriya.platform_settings (key, value) values (${row.key}, ${row.value})`
  if (!saved.model) await sql`delete from kriya.models where id = ${STUB_MODEL}`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  fs.rmSync(SAVED)
  console.log("restore: local test values removed")
}

// The model upstream: a plain answer (DSH's own title request included)
const seen = []
function upstream() {
  return http
    .createServer((req, res) => {
      let raw = ""
      req.on("data", (part) => (raw += part))
      req.on("end", () => {
        const body = JSON.parse(raw || "{}")
        seen.push({ model: body.model, tools: body.tools?.length ?? 0 })
        const base = {
          id: "stub",
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
        }
        const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
        res.writeHead(200, { "content-type": "text/event-stream" })
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: ANSWER },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        send({
          ...base,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        res.end("data: [DONE]\n\n")
      })
    })
    .listen(6797, "127.0.0.1")
}

async function device(home) {
  const [user] = await sql`select id from auth.users where email = ${EMAIL}`
  const [agent] =
    await sql`select id from kriya.agents where user_id = ${user.id} order by created_at limit 1`
  await sql`delete from kriya.harness_devices where name = ${DEVICE}`
  const token = randomBytes(32).toString("base64url")
  const [row] = await sql`insert into kriya.harness_devices
      (user_id, agent_id, name, platform, token_hash)
    values (${user.id}, ${agent.id}, ${DEVICE}, 'darwin',
      ${createHash("sha256").update(token).digest("hex")}) returning id`
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(home, "device.json"),
    JSON.stringify({ url: APP_URL, token, deviceId: row.id }),
    { mode: 0o600 }
  )
  return row.id
}

// The editor's side: newline-delimited JSON-RPC over the child's stdio
function editor(home, cwd) {
  const child = spawn(process.execPath, [path.join(CLIENT, "bin", "kriya.js"), "acp"], {
    cwd,
    env: { ...process.env, KRIYA_HOME: home },
  })
  const pending = new Map()
  const frames = []
  let stderr = ""
  let buffer = ""
  let next = 0
  child.stderr.on("data", (d) => (stderr += d))
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let at; (at = buffer.indexOf("\n")) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      frames.push(message)
      if (!message.method && pending.has(message.id)) pending.get(message.id)(message)
    }
  })
  const exited = new Promise((done) => child.on("exit", done))
  return {
    frames,
    stderr: () => stderr,
    request(method, params) {
      const id = ++next
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 120_000)
        pending.set(id, (m) => (clearTimeout(timer), done(m)))
      })
    },
    close: () => (child.stdin.end(), exited),
  }
}

async function run() {
  const stub = upstream()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-h11-home-"))
  const deviceId = await device(home)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-h11-ws-"))
  const acp = editor(home, cwd)
  try {
    const init = await acp.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    const session = await acp.request("session/new", { cwd, mcpServers: [] })
    const prompt = await acp.request("session/prompt", {
      sessionId: session.result.sessionId,
      prompt: [{ type: "text", text: "Say hello" }],
    })
    const exit = await acp.close()
    const reply = acp.frames
      .filter((f) => f.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((f) => f.params.update.content.text)
      .join("")
    const usage = await sql`select tier, model, status from kriya.harness_usage
      where device_id = ${deviceId} order by created_at`
    const model = session.result.configOptions.find((o) => o.id === "model")
    const result = {
      initialize: {
        protocolVersion: init.result?.protocolVersion,
        agent: init.result?.agentInfo?.name,
      },
      sessionModel: model?.currentValue,
      stopReason: prompt.result?.stopReason,
      reply,
      upstreamCalls: seen,
      gatewayLedger: usage,
      exit,
      everyStdoutLineAFrame: acp.frames.every((f) => f.jsonrpc === "2.0"),
    }
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(
      path.join(OUT, "results.json"),
      JSON.stringify(result, null, 2) + "\n"
    )
    console.log(JSON.stringify(result, null, 2))
    const ok =
      result.initialize.protocolVersion === 1 &&
      result.sessionModel === JSON.stringify(["kriya", "balanced"]) &&
      result.stopReason === "end_turn" &&
      reply === ANSWER &&
      seen.length > 0 &&
      usage.length === seen.length &&
      usage.every((u) => u.tier === "balanced" && u.status !== "failed") &&
      exit === 0
    console.log(
      ok ? "H11 end-to-end: PASS" : `H11 end-to-end: FAIL\n${acp.stderr().slice(-1500)}`
    )
    if (!ok) process.exitCode = 1
  } finally {
    stub.close()
  }
}

const step = { setup, run, restore }[process.argv[2]]
if (!step) throw new Error("usage: verify-h11-acp.mjs setup|run|restore")
await step().finally(() => sql.end())
