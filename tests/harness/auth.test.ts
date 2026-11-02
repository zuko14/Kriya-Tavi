import { createHash } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Device identity (track H, H2; HD-05, API_AND_CONTRACTS §2; TEST_STRATEGY
// HT-AUTH-01…08): the device flow from code to token, tokens stored only as
// sha256, revoked, idle and suspended devices refused, codes that expired,
// were denied or used refused, rate limits, and device tokens accepted only
// by authenticateDevice on harness routes.

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  // Signed out: the real one redirects, which throws
  requireUser: async () => {
    if (!state.user) throw new Error("NEXT_REDIRECT")
    return { id: state.user }
  },
}))
// No Supabase session in these requests
vi.mock("@/lib/supabase", () => ({
  createSupabase: async () => ({ auth: { getClaims: async () => ({ data: null }) } }),
}))

import { approveDevice, denyDevice } from "@/actions/harness"
import { DELETE as revokeSelf } from "@/app/api/harness/v1/device/route"
import { POST as code } from "@/app/api/harness/v1/device/code/route"
import { POST as token } from "@/app/api/harness/v1/device/token/route"
import { GET as me } from "@/app/api/harness/v1/me/route"
import { authenticate, authenticateDevice } from "@/lib/auth"

import type { TestDb } from "../db/harness"
import { call, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let alice: string
let newUser: () => Promise<string>

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const body = async (res: Response) => (await res.json()) as Record<string, unknown>
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows[0]

// Code → approve as the person → token. A new person by default: the
// connect action allows each person 10 answers a minute (HT-AUTH-07)
async function signIn(user?: string, agentId: string | null = null) {
  user ??= await newUser()
  const started = await body(
    await code(
      call("POST", "/device/code", {
        body: { deviceName: "laptop", platform: "darwin", clientVersion: "0.1.0" },
      })
    )
  )
  state.user = user
  expect(await approveDevice({ code: String(started.userCode), agentId })).toEqual({
    ok: true,
  })
  const issued = await token(
    call("POST", "/device/token", { body: { deviceCode: started.deviceCode } })
  )
  expect(issued.status).toBe(200)
  return { ...(await body(issued)), deviceCode: String(started.deviceCode) } as {
    token: string
    deviceId: string
    deviceCode: string
  }
}

// Polling faster than `interval` is refused: step the last poll back
const sincePoll = (deviceCode: string) =>
  pg.query(
    "update kriya.harness_device_codes set last_polled_at = now() - interval '10 seconds' where device_code_hash = $1",
    [sha(deviceCode)]
  )

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  newUser = db.createUser
  alice = await newUser()
})

beforeEach(() => harnessEnv())

describe("HT-AUTH-01: the device flow", () => {
  it("code → approve in a session → token once → an authenticated request", async () => {
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('agent-h', $1, 'Arjun', 'engineer', 'g')",
      [alice]
    )
    const started = await code(
      call("POST", "/device/code", {
        body: { deviceName: "work laptop", platform: "linux", clientVersion: "0.1.0" },
      })
    )
    expect(started.status).toBe(200)
    const flow = await body(started)
    expect(flow).toMatchObject({
      verificationUrl: "https://kriya.example/connect/device",
      expiresIn: 600,
      interval: 5,
    })
    expect(String(flow.userCode)).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(String(flow.deviceCode)).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const pending = await token(
      call("POST", "/device/token", { body: { deviceCode: flow.deviceCode } })
    )
    expect(pending.status).toBe(428)
    expect(await body(pending)).toMatchObject({ error: "pending" })

    state.user = alice
    // The person may type the code without the dash
    expect(
      await approveDevice({
        code: String(flow.userCode).replace("-", ""),
        agentId: "agent-h",
      })
    ).toEqual({ ok: true })
    await sincePoll(String(flow.deviceCode))
    const issued = await token(
      call("POST", "/device/token", { body: { deviceCode: flow.deviceCode } })
    )
    expect(issued.status).toBe(200)
    const { token: secret, deviceId } = (await body(issued)) as {
      token: string
      deviceId: string
    }
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const res = await me(call("GET", "/me", { token: secret }))
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({
      agent: { id: "agent-h", name: "Arjun" },
      harness: { enabled: false, capMicroInr: 0, usedMicroInr: 0, unpriced: 0 },
      minClientVersion: "0.0.0",
    })
    expect(
      await one(
        "select user_id, agent_id, name, platform from kriya.harness_devices where id = $1",
        [deviceId]
      )
    ).toEqual({
      user_id: alice,
      agent_id: "agent-h",
      name: "work laptop",
      platform: "linux",
    })
  })
})

describe("HT-AUTH-02: only hashes are stored; a token is issued once", () => {
  it("no plain token or device code in the database; a second token call gets 410", async () => {
    const { token: secret, deviceId, deviceCode } = await signIn()
    const dump = JSON.stringify(
      (await pg.query("select * from kriya.harness_devices")).rows.concat(
        (await pg.query("select * from kriya.harness_device_codes")).rows
      )
    )
    expect(dump).not.toContain(secret)
    expect(dump).not.toContain(deviceCode)
    expect(
      await one("select token_hash from kriya.harness_devices where id = $1", [deviceId])
    ).toEqual({
      token_hash: sha(secret),
    })
    await sincePoll(deviceCode)
    const again = await token(call("POST", "/device/token", { body: { deviceCode } }))
    expect(again.status).toBe(410)
  })
})

describe("HT-AUTH-03 / -04 / -05: revoked, idle and suspended", () => {
  it("revoked → 401, from Account or by the device itself", async () => {
    const first = await signIn()
    await pg.query("update kriya.harness_devices set revoked_at = now() where id = $1", [
      first.deviceId,
    ])
    expect((await me(call("GET", "/me", { token: first.token }))).status).toBe(401)
    const second = await signIn()
    expect(
      (await revokeSelf(call("DELETE", "/device", { token: second.token }))).status
    ).toBe(204)
    expect((await me(call("GET", "/me", { token: second.token }))).status).toBe(401)
  })

  it("unused past harness.deviceIdleDays → 401", async () => {
    harnessEnv({ KRIYA_HARNESS_DEVICE_IDLE_DAYS: "30" })
    const { token: secret, deviceId } = await signIn()
    await pg.query(
      "update kriya.harness_devices set last_used_at = now() - interval '31 days' where id = $1",
      [deviceId]
    )
    expect((await me(call("GET", "/me", { token: secret }))).status).toBe(401)
  })

  it("a suspended person → 403", async () => {
    const person = await newUser()
    const { token: secret } = await signIn(person)
    await pg.query("update kriya.profiles set status = 'suspended' where id = $1", [
      person,
    ])
    const res = await me(call("GET", "/me", { token: secret }))
    expect(res.status).toBe(403)
    expect(await body(res)).toMatchObject({ error: "suspended" })
  })
})

describe("HT-AUTH-06: codes", () => {
  const start = async () =>
    body(
      await code(
        call("POST", "/device/code", {
          body: { deviceName: "laptop", platform: "win32", clientVersion: "0.1.0" },
        })
      )
    )

  it("expired, denied and used codes are refused; approving needs a session", async () => {
    const expired = await start()
    await pg.query(
      "update kriya.harness_device_codes set expires_at = now() - interval '1 second' where device_code_hash = $1",
      [sha(String(expired.deviceCode))]
    )
    state.user = alice
    expect(
      await approveDevice({ code: String(expired.userCode), agentId: null })
    ).toMatchObject({ error: expect.any(String) })
    expect(
      (
        await token(
          call("POST", "/device/token", { body: { deviceCode: expired.deviceCode } })
        )
      ).status
    ).toBe(410)

    const denied = await start()
    expect(await denyDevice({ code: String(denied.userCode) })).toEqual({ ok: true })
    const refused = await token(
      call("POST", "/device/token", { body: { deviceCode: denied.deviceCode } })
    )
    expect(refused.status).toBe(403)
    expect(await body(refused)).toMatchObject({ error: "denied" })
    expect(
      await approveDevice({ code: String(denied.userCode), agentId: null })
    ).toMatchObject({ error: expect.any(String) })

    const used = await signIn()
    const reused = await one<{ user_code: string }>(
      "select user_code from kriya.harness_device_codes where device_code_hash = $1",
      [sha(used.deviceCode)]
    )
    expect(await approveDevice({ code: reused.user_code, agentId: null })).toMatchObject({
      error: expect.any(String),
    })

    // Another person's agent can't be chosen
    const bob = await newUser()
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('agent-bob', $1, 'B', 'r', 'g')",
      [bob]
    )
    const theirs = await start()
    expect(
      await approveDevice({ code: String(theirs.userCode), agentId: "agent-bob" })
    ).toMatchObject({ error: expect.any(String) })

    // No session: requireUser redirects (thrown), nothing is approved
    const lone = await start()
    state.user = ""
    await expect(
      approveDevice({ code: String(lone.userCode), agentId: null })
    ).rejects.toThrow()
    expect(
      await one(
        "select approved_at from kriya.harness_device_codes where user_code = $1",
        [String(lone.userCode).replace("-", "")]
      )
    ).toEqual({ approved_at: null })
  })

  it("refuses a request that isn't the contract", async () => {
    for (const bad of [
      { deviceName: "", platform: "darwin", clientVersion: "0.1.0" },
      { deviceName: "x", platform: "android", clientVersion: "0.1.0" },
      { deviceName: "x", platform: "darwin", clientVersion: "0.1.0", extra: true },
    ]) {
      expect((await code(call("POST", "/device/code", { body: bad }))).status).toBe(400)
    }
  })
})

describe("HT-AUTH-07: rate limits", () => {
  it("/device/code per address, polling faster than interval, the connect action", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await code(
        call("POST", "/device/code", {
          ip: "203.0.113.7",
          body: { deviceName: "laptop", platform: "darwin", clientVersion: "0.1.0" },
        })
      )
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses[10]).toBe(429)

    const flow = await body(
      await code(
        call("POST", "/device/code", {
          body: { deviceName: "laptop", platform: "darwin", clientVersion: "0.1.0" },
        })
      )
    )
    expect(
      (
        await token(
          call("POST", "/device/token", { body: { deviceCode: flow.deviceCode } })
        )
      ).status
    ).toBe(428)
    const fast = await token(
      call("POST", "/device/token", { body: { deviceCode: flow.deviceCode } })
    )
    expect(fast.status).toBe(429)
    expect(await body(fast)).toMatchObject({ error: "rate_limited" })

    const person = await newUser()
    state.user = person
    const results: unknown[] = []
    for (let i = 0; i < 11; i++) results.push(await denyDevice({ code: "ZZZZZZZZ" }))
    expect(results.at(-1)).toMatchObject({ error: expect.stringMatching(/too many/i) })
  })

  it("requests per minute per device (harness.rpm)", async () => {
    harnessEnv({ KRIYA_HARNESS_RPM: "2" })
    const { token: secret } = await signIn()
    const statuses = []
    for (let i = 0; i < 3; i++)
      statuses.push((await me(call("GET", "/me", { token: secret }))).status)
    expect(statuses).toEqual([200, 200, 429])
  })
})

describe("HT-AUTH-08: device tokens only on harness routes, through authenticateDevice", () => {
  it("a session cookie isn't a device; a device token isn't a session", async () => {
    const { token: secret } = await signIn()
    const cookieOnly = new Request("https://kriya.example/api/harness/v1/me", {
      headers: { cookie: "sb-access-token=anything", "x-kriya-harness": "0.1.0" },
    })
    expect(await authenticateDevice(cookieOnly)).toBeNull()
    expect((await me(cookieOnly)).status).toBe(401)
    for (const header of [
      `Token ${secret}`,
      `Bearer ${secret}x`,
      "Bearer",
      `bearer  ${secret} extra`,
    ]) {
      const req = new Request("https://kriya.example/api/harness/v1/me", {
        headers: { authorization: header },
      })
      expect(await authenticateDevice(req), header).toBeNull()
    }
    // The session helpers read only the Supabase session: a device token in
    // the request gives no session
    expect(await authenticate()).toBeNull()
  })
})
