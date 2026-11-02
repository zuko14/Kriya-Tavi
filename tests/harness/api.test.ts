import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// HT-API-08 (H2 routes): no route answers with, or acts on, another
// person's rows; two people, every route. Later phases add their routes.

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  requireUser: async () => ({ id: state.user }),
}))

import { approveDevice, renameDevice, revokeDevice } from "@/actions/harness"
import { DELETE as revokeSelf } from "@/app/api/harness/v1/device/route"
import { POST as code } from "@/app/api/harness/v1/device/code/route"
import { POST as token } from "@/app/api/harness/v1/device/token/route"
import { GET as me } from "@/app/api/harness/v1/me/route"

import type { TestDb } from "../db/harness"
import { call, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let alice: string
let bob: string

async function signIn(user: string, name: string) {
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, $3, 'r', 'g')",
    [`agent-${name}`, user, name]
  )
  const flow = (await (
    await code(
      call("POST", "/device/code", {
        body: { deviceName: name, platform: "linux", clientVersion: "0.1.0" },
      })
    )
  ).json()) as { deviceCode: string; userCode: string }
  state.user = user
  await approveDevice({ code: flow.userCode, agentId: `agent-${name}` })
  await pg.query(
    "update kriya.harness_device_codes set last_polled_at = now() - interval '10 seconds'"
  )
  return (await (
    await token(call("POST", "/device/token", { body: { deviceCode: flow.deviceCode } }))
  ).json()) as {
    token: string
    deviceId: string
  }
}

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  alice = await db.createUser()
  bob = await db.createUser()
})
beforeEach(() => harnessEnv())

describe("HT-API-08: one person's rows only", () => {
  it("/me and DELETE /device act on the caller alone; Account actions on the person's own devices", async () => {
    const a = await signIn(alice, "Asha")
    const b = await signIn(bob, "Bilal")
    expect(await (await me(call("GET", "/me", { token: a.token }))).json()).toMatchObject(
      {
        agent: { name: "Asha" },
      }
    )
    expect(await (await me(call("GET", "/me", { token: b.token }))).json()).toMatchObject(
      {
        agent: { name: "Bilal" },
      }
    )

    // Bob's Account actions can't touch Alice's device
    state.user = bob
    expect(await renameDevice(a.deviceId, "mine now")).toMatchObject({
      error: expect.any(String),
    })
    expect(await revokeDevice(a.deviceId)).toMatchObject({ error: expect.any(String) })
    expect((await me(call("GET", "/me", { token: a.token }))).status).toBe(200)

    // A device revoking itself leaves the other person's
    expect((await revokeSelf(call("DELETE", "/device", { token: b.token }))).status).toBe(
      204
    )
    expect((await me(call("GET", "/me", { token: a.token }))).status).toBe(200)
    const { rows } = await pg.query<{ name: string; revoked: boolean }>(
      "select name, revoked_at is not null as revoked from kriya.harness_devices order by name"
    )
    expect(rows).toEqual([
      { name: "Asha", revoked: false },
      { name: "Bilal", revoked: true },
    ])

    state.user = alice
    expect(await renameDevice(a.deviceId, "Work laptop")).toEqual({ ok: true })
    expect(await revokeDevice(a.deviceId)).toEqual({ ok: true })
    expect((await me(call("GET", "/me", { token: a.token }))).status).toBe(401)
  })
})
