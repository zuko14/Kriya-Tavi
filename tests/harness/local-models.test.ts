import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// S-1 local models (docs/kriya-harness/LOCAL_MODELS.md, owner decision SI-01):
// GET /models says `localModels: 1` only with harness.localModels on and the
// orchestra offered. Off, the body is exactly as before. HT-LM-01.

vi.mock("server-only", () => ({}))

import { GET as models } from "@/app/api/harness/v1/models/route"
import { ModelsResponse } from "@/lib/harness/contract"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let token: string

const list = async () => (await models(call("GET", "/models", { token }))).json()

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  ;({ token } = await deviceFor(pg, await db.createUser()))
})
beforeEach(async () => {
  harnessEnv({
    KRIYA_HARNESS_WORKFORCE: undefined,
    KRIYA_HARNESS_LOCAL_MODELS: undefined,
    KRIYA_HARNESS_ORCHESTRA_HEAD: undefined,
    KRIYA_HARNESS_ORCHESTRA_WORKER: undefined,
  })
  await pg.query(
    `update kriya.plans set allowed_tiers = '{budget,balanced,escalation}' where id = 'free'`
  )
})

describe("HT-LM-01: the local models advert", () => {
  it("off (the default): no field, with or without the orchestra", async () => {
    expect(await list()).not.toHaveProperty("localModels")
    harnessEnv({ KRIYA_HARNESS_WORKFORCE: "on" })
    expect(await list()).not.toHaveProperty("localModels")
  })

  it("on with the orchestra: localModels 1, the rest of the body unchanged, valid by the contract", async () => {
    harnessEnv({ KRIYA_HARNESS_WORKFORCE: "on" })
    const before = await list()
    harnessEnv({ KRIYA_HARNESS_WORKFORCE: "on", KRIYA_HARNESS_LOCAL_MODELS: "on" })
    const { localModels, ...rest } = await list()
    expect(localModels).toBe(1)
    expect(rest).toEqual(before)
    ModelsResponse.parse({ ...rest, localModels })
  })

  it("withheld without the orchestra: workforce off, or head and worker the same", async () => {
    harnessEnv({ KRIYA_HARNESS_LOCAL_MODELS: "on" })
    expect(await list()).not.toHaveProperty("localModels")
    harnessEnv({
      KRIYA_HARNESS_WORKFORCE: "on",
      KRIYA_HARNESS_LOCAL_MODELS: "on",
      KRIYA_HARNESS_ORCHESTRA_HEAD: "budget",
      KRIYA_HARNESS_ORCHESTRA_WORKER: "budget",
    })
    expect(await list()).not.toHaveProperty("localModels")
  })
})
