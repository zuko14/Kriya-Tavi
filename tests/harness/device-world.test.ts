import { randomUUID } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { GET as world } from "@/app/api/harness/v1/world/route"
import { RunnerClient } from "@/lib/cloud/client"
import { WorkspaceProviderError, type WorkspaceSpec } from "@/lib/cloud/provider"
import { DeviceWorkspaceProvider } from "@/lib/cloud/providers/device"
import { runnerToken } from "@/lib/cloud/token"
import { createRelay, webVerifier } from "@/relay/index"

import { createTestDb, type TestDb } from "../db/harness"
import { serveDevice } from "./device-bridge"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

// H10, HD-12: a person's machine as the execution world of a cloud task.
// HT-DEV-01 migration, -02 the device-world route, -03 the relay handshake,
// -04 forwarding, -05 the `device` provider. The relay verifies device
// tokens through the route (it has no database), so these run end to end:
// PGlite → authenticateDevice → relay → a device bridge → the real runner.

const SECRET = "r".repeat(43)
const read = (dir: string, file: string) =>
  fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")

let pg: TestDb
let newUser: () => Promise<string>
let relay: Awaited<ReturnType<typeof createRelay>>
const folders: string[] = []
const devices: Awaited<ReturnType<typeof serveDevice>>[] = []

const folder = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-world-"))
  folders.push(dir)
  return dir
}

async function connect(deviceId: string, token: string, dir = folder()) {
  const device = await serveDevice({ relayUrl: relay.url, deviceId, token, folder: dir })
  devices.push(device)
  return device
}

// The relay's check of a device token: the real route, in process
const verify = async (token: string, version: string | null) => {
  const res = await world(call("GET", "/world", { token, version: version ?? null }))
  if (!res.ok) return null
  return ((await res.json()) as { deviceId: string }).deviceId
}

const forward = (deviceId: string, route: string, init: RequestInit = {}) =>
  fetch(`${relay.url}/v1/forward/${deviceId}${route}`, {
    ...init,
    headers: { "x-kriya-relay-secret": SECRET, ...init.headers },
  })

const spec = (userId: string, generation = 1): WorkspaceSpec => {
  const workspaceId = randomUUID()
  return {
    workspaceId,
    userId,
    generation,
    image: "device",
    size: "device",
    network: "registries",
    runnerToken: runnerToken(workspaceId, generation),
    limits: {},
    timeoutSeconds: 600,
  }
}

beforeAll(async () => {
  harnessEnv({
    KRIYA_HARNESS_DEVICE_WORLD: "on",
    KRIYA_RELAY_URL: "https://relay.kriya.example",
    KRIYA_WORKSPACE_SECRET: "s".repeat(43),
  })
  ;({ pg, createUser: newUser } = await harnessDb())
  relay = await createRelay({ secret: SECRET, verify, reverifyMs: 200 })
})

afterEach(async () => {
  for (const device of devices.splice(0)) await device.close()
})

afterAll(async () => {
  await relay.close()
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true })
})

describe("HT-DEV-01: provider 'device' (PX-06)", () => {
  it("is accepted after the migration, refused after its rollback, and comes back", async () => {
    const db = await createTestDb()
    await db.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key)"
    )
    const user = randomUUID()
    await db.query("insert into auth.users (id) values ($1)", [user])
    const insert = (provider: string) =>
      db.query(
        "insert into kriya.workspaces (user_id, provider, image, size) values ($1, $2, 'i', '2c-4g')",
        [user, provider]
      )
    await insert("device")
    // The rollback refuses while a device workspace exists: nothing is lost
    await expect(
      db.exec(read("rollback", "20270301000100_harness_device_provider.down.sql"))
    ).rejects.toThrow(/device/)
    await db.query("delete from kriya.workspaces where provider = 'device'")
    await db.exec(read("rollback", "20270301000100_harness_device_provider.down.sql"))
    await expect(insert("device")).rejects.toThrow(/check/)
    await insert("e2b")
    await db.exec(read("migrations", "20270301000100_harness_device_provider.sql"))
    await insert("device")
  })
})

describe("HT-DEV-02: the device-world route", () => {
  it("answers this device's id and the relay, only with harness.deviceWorld on", async () => {
    const { token, deviceId } = await deviceFor(pg, await newUser())
    const res = await world(call("GET", "/world", { token }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deviceId,
      relayUrl: "https://relay.kriya.example",
    })
    expect((await world(call("GET", "/world", { token: "x".repeat(43) }))).status).toBe(
      401
    )
    harnessEnv({
      KRIYA_HARNESS_DEVICE_WORLD: "off",
      KRIYA_RELAY_URL: "https://relay.kriya.example",
      KRIYA_WORKSPACE_SECRET: "s".repeat(43),
    })
    try {
      expect((await world(call("GET", "/world", { token }))).status).toBe(404)
    } finally {
      harnessEnv({
        KRIYA_HARNESS_DEVICE_WORLD: "on",
        KRIYA_RELAY_URL: "https://relay.kriya.example",
        KRIYA_WORKSPACE_SECRET: "s".repeat(43),
      })
    }
  })
})

describe("HT-DEV-03: the relay handshake", () => {
  it("accepts a device with its own valid token", async () => {
    const { token, deviceId } = await deviceFor(pg, await newUser())
    expect((await connect(deviceId, token)).opened).toBe(true)
    const res = await fetch(`${relay.url}/v1/devices/${deviceId}`, {
      headers: { "x-kriya-relay-secret": SECRET },
    })
    expect(await res.json()).toEqual({ connected: true })
  })

  it("refuses a bad token, another device's token and a revoked device", async () => {
    const { token, deviceId } = await deviceFor(pg, await newUser())
    const other = await deviceFor(pg, await newUser())
    expect((await connect(deviceId, "y".repeat(43))).opened).toBe(false)
    expect((await connect(deviceId, other.token)).opened).toBe(false)
    expect((await connect("not-a-uuid", token)).opened).toBe(false)
    await pg.query("update kriya.harness_devices set revoked_at = now() where id = $1", [
      deviceId,
    ])
    expect((await connect(deviceId, token)).opened).toBe(false)
  })

  it("drops a connection whose device is revoked later", async () => {
    const { token, deviceId } = await deviceFor(pg, await newUser())
    const device = await connect(deviceId, token)
    expect(device.opened).toBe(true)
    const closed = new Promise((done) => device.socket.addEventListener("close", done))
    await pg.query("update kriya.harness_devices set revoked_at = now() where id = $1", [
      deviceId,
    ])
    await closed
    const res = await fetch(`${relay.url}/v1/devices/${deviceId}`, {
      headers: { "x-kriya-relay-secret": SECRET },
    })
    expect(await res.json()).toEqual({ connected: false })
  })
})

// Re-audit 2026-11-02: the token check is asynchronous, so the raw socket
// can fail while it runs; a reset there, or a check that throws, must never
// take the relay (and every other machine's connection) down
describe("HT-DEV-06: the relay survives a bad handshake", () => {
  it("a client that resets mid-check and a check that throws are refused; the relay keeps serving", async () => {
    let release = () => {}
    const slow = new Promise<void>((done) => (release = done))
    const fragile = await createRelay({
      secret: SECRET,
      verify: async (token) => {
        if (token === "t".repeat(43)) throw new Error("web app down")
        await slow
        return null
      },
    })
    try {
      const port = Number(new URL(fragile.url).port)
      const upgrade = (token: string) =>
        [
          `GET /v1/device/${randomUUID()} HTTP/1.1`,
          "Host: relay",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Authorization: Bearer ${token}`,
          "",
          "",
        ].join("\r\n")
      // Reset while the check is still running
      const reset = net.connect(port, "127.0.0.1")
      await new Promise((done) => reset.once("connect", done))
      reset.write(upgrade("r".repeat(43)))
      await new Promise((done) => setTimeout(done, 50))
      reset.resetAndDestroy()
      await new Promise((done) => setTimeout(done, 50))
      release()
      // A check that throws answers 401
      const thrown = net.connect(port, "127.0.0.1")
      const answer = await new Promise<string>((done) => {
        let text = ""
        thrown.on("data", (chunk) => (text += chunk))
        thrown.on("close", () => done(text))
        thrown.on("error", () => done(text))
        thrown.write(upgrade("t".repeat(43)))
      })
      expect(answer).toMatch(/^HTTP\/1\.1 401/)
      const health = await fetch(`${fragile.url}/health`)
      expect(health.status).toBe(200)
    } finally {
      release()
      await fragile.close()
    }
  })
})

describe("HT-DEV-07: kriya-web outages are not revocations", () => {
  it("webVerifier: 401/404 refuse, 429/5xx and network errors throw", async () => {
    const answers = [401, 404, 429, 503]
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const status = answers.shift()
        if (status === undefined) throw new TypeError("fetch failed")
        return new Response("{}", { status })
      })
    )
    try {
      const check = webVerifier("https://kriya.example")
      expect(await check("x".repeat(43), "0.1.0")).toBeNull()
      expect(await check("x".repeat(43), "0.1.0")).toBeNull()
      await expect(check("x".repeat(43), "0.1.0")).rejects.toThrow(/429/)
      await expect(check("x".repeat(43), "0.1.0")).rejects.toThrow(/503/)
      await expect(check("x".repeat(43), "0.1.0")).rejects.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("a connected machine stays through a failing re-check, and leaves on a refusal", async () => {
    let mode: "ok" | "down" | "refuse" = "ok"
    const { token, deviceId } = await deviceFor(pg, await newUser())
    const flaky = await createRelay({
      secret: SECRET,
      reverifyMs: 50,
      verify: async (t, v) => {
        if (mode === "down") throw new Error("kriya-web answered 503")
        if (mode === "refuse") return null
        return verify(t, v)
      },
    })
    try {
      const device = await serveDevice({
        relayUrl: flaky.url,
        deviceId,
        token,
        folder: folder(),
      })
      devices.push(device)
      expect(device.opened).toBe(true)
      mode = "down"
      await new Promise((done) => setTimeout(done, 300))
      expect(flaky.connected()).toContain(deviceId)
      mode = "refuse"
      await vi.waitFor(() => expect(flaky.connected()).not.toContain(deviceId))
    } finally {
      await flaky.close()
    }
  })
})

describe("HT-DEV-04: forwarding runner requests", () => {
  it("needs the relay secret on every worker request", async () => {
    const { deviceId } = await deviceFor(pg, await newUser())
    for (const headers of [{}, { "x-kriya-relay-secret": "wrong" }] as Record<
      string,
      string
    >[]) {
      const res = await fetch(`${relay.url}/v1/forward/${deviceId}/v1/health`, {
        headers,
      })
      expect(res.status).toBe(401)
      expect(
        (await fetch(`${relay.url}/v1/devices/${deviceId}`, { headers })).status
      ).toBe(401)
    }
  })

  it("health, write and read reach the runner on the device and come back", async () => {
    const { token, deviceId } = await deviceFor(pg, await newUser())
    await connect(deviceId, token)
    const workspaceId = randomUUID()
    const ref = `device-${deviceId}-${workspaceId}-1`
    const runner = runnerToken(workspaceId, 1)
    const open = await forward(deviceId, "/world/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref,
        generation: 1,
        token: runner,
        limits: {},
        fresh: true,
      }),
    })
    expect(open.status).toBe(200)
    const client = new RunnerClient(
      `${relay.url}/v1/forward/${deviceId}`,
      runner,
      undefined,
      { "x-kriya-relay-secret": SECRET, "x-kriya-world-ref": ref }
    )
    expect(await client.health()).toMatchObject({ ok: true, generation: 1 })
    await client.write({ path: "notes.txt", content: "hello from the cloud\n" })
    expect(
      ((await client.read({ path: "notes.txt" })) as { text: string }).text
    ).toContain("hello from the cloud")
    // A streamed command, its output and exit code
    const lines: string[] = []
    const end = await client.exec(
      { command: "echo one; echo two", timeoutSeconds: 10 },
      { onOutput: (event) => lines.push(event.text) }
    )
    expect(end.exitCode).toBe(0)
    expect(lines.join("")).toContain("two")
    // The runner's own bearer check still holds behind the relay
    const wrong = new RunnerClient(
      `${relay.url}/v1/forward/${deviceId}`,
      "z".repeat(43),
      undefined,
      {
        "x-kriya-relay-secret": SECRET,
        "x-kriya-world-ref": ref,
      }
    )
    await expect(wrong.read({ path: "notes.txt" })).rejects.toMatchObject({ status: 401 })
  })

  it("answers 502 for a device that isn't connected or goes away mid-request", async () => {
    const { token, deviceId } = await deviceFor(pg, await newUser())
    expect((await forward(deviceId, "/v1/health")).status).toBe(502)
    const device = await connect(deviceId, token)
    const workspaceId = randomUUID()
    const ref = `device-${deviceId}-${workspaceId}-1`
    const runner = runnerToken(workspaceId, 1)
    await forward(deviceId, "/world/open", {
      method: "POST",
      body: JSON.stringify({
        ref,
        generation: 1,
        token: runner,
        limits: {},
        fresh: true,
      }),
    })
    const client = new RunnerClient(
      `${relay.url}/v1/forward/${deviceId}`,
      runner,
      undefined,
      {
        "x-kriya-relay-secret": SECRET,
        "x-kriya-world-ref": ref,
      }
    )
    const slow = client.exec({ command: "sleep 5", timeoutSeconds: 10 })
    await new Promise((done) => setTimeout(done, 300))
    device.socket.close()
    await expect(slow).rejects.toThrow()
    expect((await forward(deviceId, "/v1/health")).status).toBe(502)
  })
})

describe("HT-DEV-05: the device provider", () => {
  const provider = () =>
    new DeviceWorkspaceProvider({ relayUrl: relay.url, secret: SECRET })

  it("create opens a workspace on the person's connected machine", async () => {
    const user = await newUser()
    const { token, deviceId } = await deviceFor(pg, user)
    const dir = folder()
    await connect(deviceId, token, dir)
    const s = spec(user)
    const opened = await provider().create(s)
    expect(opened.ref).toBe(`device-${deviceId}-${s.workspaceId}-1`)
    expect(opened.runnerUrl).toBe(`${relay.url}/v1/forward/${deviceId}`)
    const client = new RunnerClient(
      opened.runnerUrl,
      s.runnerToken,
      undefined,
      opened.headers
    )
    expect(await client.health()).toMatchObject({ ok: true, generation: 1 })
    expect(fs.existsSync(path.join(dir, `${s.workspaceId}-1`))).toBe(true)
    expect(await provider().list()).toContainEqual({
      ref: opened.ref,
      workspaceId: s.workspaceId,
      running: true,
    })
  })

  it("never opens on another person's machine; none connected is a plain refusal", async () => {
    const user = await newUser()
    const other = await deviceFor(pg, await newUser())
    await connect(other.deviceId, other.token)
    await expect(provider().create(spec(user))).rejects.toBeInstanceOf(
      WorkspaceProviderError
    )
    await expect(provider().create(spec(user))).rejects.toThrow(/kriya serve/)
    // A ref naming someone else's device is not this person's workspace
    const s = spec(user)
    expect(
      await provider().resume(`device-${other.deviceId}-${s.workspaceId}-1`, s)
    ).toBeNull()
  })

  it("resume: back on a reconnected machine; offline keeps it paused; a lost folder is null", async () => {
    const user = await newUser()
    const { token, deviceId } = await deviceFor(pg, user)
    const dir = folder()
    let device = await connect(deviceId, token, dir)
    const s = spec(user)
    const opened = await provider().create(s)
    await provider().pause(opened.ref)
    await device.close()
    // Offline: an error, so the session leaves the workspace paused
    await expect(provider().resume(opened.ref, s)).rejects.toBeInstanceOf(
      WorkspaceProviderError
    )
    // Lifecycle calls stay idempotent while it's away
    await provider().pause(opened.ref)
    await provider().extend()
    device = await connect(deviceId, token, dir)
    const again = await provider().resume(opened.ref, s)
    expect(again?.ref).toBe(opened.ref)
    const client = new RunnerClient(
      again!.runnerUrl,
      s.runnerToken,
      undefined,
      again!.headers
    )
    expect(await client.health()).toMatchObject({ ok: true })
    await provider().destroy(opened.ref)
    await provider().destroy(opened.ref)
    expect(fs.existsSync(path.join(dir, `${s.workspaceId}-1`))).toBe(false)
    expect(await provider().resume(opened.ref, s)).toBeNull()
  })
})
