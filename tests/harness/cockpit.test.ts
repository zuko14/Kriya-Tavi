import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Developer cockpit (docs/kriya-harness/DEVELOPER_COCKPIT.md): GET /models says
// `cockpit: 1` only with harness.cockpit on. Off, the body is as before. HT-CKP-01.

vi.mock("server-only", () => ({}))

import { GET as models } from "@/app/api/harness/v1/models/route"
import { ModelsResponse } from "@/lib/harness/contract"

import { deviceFor, harnessDb, harnessEnv, call } from "./setup"

let token: string
const list = async () => (await models(call("GET", "/models", { token }))).json()

beforeAll(async () => {
  const db = await harnessDb()
  ;({ token } = await deviceFor(db.pg, await db.createUser()))
})
beforeEach(() => harnessEnv({ KRIYA_HARNESS_COCKPIT: undefined }))

describe("HT-CKP-01: the cockpit advert", () => {
  it("off by default; on adds only cockpit: 1, valid by the contract", async () => {
    const off = await list()
    expect(off).not.toHaveProperty("cockpit")
    harnessEnv({ KRIYA_HARNESS_COCKPIT: "on" })
    const { cockpit, ...rest } = await list()
    expect(cockpit).toBe(1)
    expect(rest).toEqual(off)
    ModelsResponse.parse({ ...rest, cockpit })
  })
})
