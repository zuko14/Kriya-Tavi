import fs from "node:fs"
import path from "node:path"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// HT-API-01 (H2 routes) and HT-API-02: every response matches
// lib/harness/contract.ts, the exported contract.json is current, old
// clients get 426, and with harness.api off every route says nothing (404).

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  requireUser: async () => ({ id: state.user }),
}))

import { sql } from "drizzle-orm"

import { approveDevice } from "@/actions/harness"
import { privileged } from "@/db"
import { DELETE as revokeSelf } from "@/app/api/harness/v1/device/route"
import { POST as code } from "@/app/api/harness/v1/device/code/route"
import { POST as token } from "@/app/api/harness/v1/device/token/route"
import { GET as me } from "@/app/api/harness/v1/me/route"
import {
  contractJson,
  DeviceCodeResponse,
  DeviceTokenResponse,
  ErrorResponse,
  MeResponse,
} from "@/lib/harness/contract"

import { call, harnessDb, harnessEnv } from "./setup"

const EXPORT = path.join(process.cwd(), "docs", "kriya-harness", "contract.json")

let alice: string

beforeAll(async () => {
  const db = await harnessDb()
  alice = await db.createUser()
})
beforeEach(() => harnessEnv())

const start = () =>
  code(
    call("POST", "/device/code", {
      body: { deviceName: "laptop", platform: "darwin", clientVersion: "0.1.0" },
    })
  )

describe("HT-API-01: the contract", () => {
  it("contract.json is the export of contract.ts (regenerate: npx tsx scripts/harness-contract.ts)", () => {
    // Compared as data: Prettier formats the file like the rest of the repo
    expect(JSON.parse(fs.readFileSync(EXPORT, "utf8"))).toEqual(contractJson())
  })

  it("every H2 response matches its schema, refusals included", async () => {
    const flow = DeviceCodeResponse.parse(await (await start()).json())
    ErrorResponse.parse(
      await (
        await token(
          call("POST", "/device/token", { body: { deviceCode: flow.deviceCode } })
        )
      ).json()
    )
    state.user = alice
    await approveDevice({ code: flow.userCode, agentId: null })
    // Polling faster than interval is refused; the test steps past it
    await privileged.execute(
      sql`update kriya.harness_device_codes set last_polled_at = now() - interval '10 seconds'`
    )
    const issued = DeviceTokenResponse.parse(
      await (
        await token(
          call("POST", "/device/token", { body: { deviceCode: flow.deviceCode } })
        )
      ).json()
    )
    MeResponse.parse(await (await me(call("GET", "/me", { token: issued.token }))).json())
    const revoked = await revokeSelf(call("DELETE", "/device", { token: issued.token }))
    expect(revoked.status).toBe(204)
    ErrorResponse.parse(
      await (await me(call("GET", "/me", { token: issued.token }))).json()
    )
  })
})

describe("HT-API-02: versions and the switch", () => {
  it("below harness.minClientVersion, or no version → 426 with the minimum", async () => {
    harnessEnv({ KRIYA_HARNESS_MIN_CLIENT_VERSION: "0.2.0" })
    for (const version of ["0.1.9", "0.0.1", null, "not-a-version"]) {
      const res = await code(
        call("POST", "/device/code", {
          version,
          body: { deviceName: "laptop", platform: "darwin", clientVersion: "0.1.0" },
        })
      )
      expect(res.status, String(version)).toBe(426)
      expect(ErrorResponse.parse(await res.json())).toMatchObject({
        error: "upgrade",
        minVersion: "0.2.0",
      })
    }
    const ok = await code(
      call("POST", "/device/code", {
        version: "0.10.0",
        body: { deviceName: "laptop", platform: "darwin", clientVersion: "0.10.0" },
      })
    )
    expect(ok.status).toBe(200)
  })

  it("harness.api off → every route 404, saying nothing", async () => {
    harnessEnv({ KRIYA_HARNESS_API: undefined })
    const responses = await Promise.all([
      start(),
      token(call("POST", "/device/token", { body: { deviceCode: "x".repeat(43) } })),
      me(call("GET", "/me", { token: "x".repeat(43) })),
      revokeSelf(call("DELETE", "/device", { token: "x".repeat(43) })),
    ])
    for (const res of responses) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found", message: "Not found." })
    }
  })
})
