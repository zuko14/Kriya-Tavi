import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Harness 2.0 W2 (docs/kriya-harness/upgrade_2.0/ORCHESTRA.md §1): GET /models
// offers the owner's head and worker levels only with harness.workforce on,
// the two different and both in the plan. Off, the body is as before. WT-ORC-03.

vi.mock("server-only", () => ({}))

import { GET as models } from "@/app/api/harness/v1/models/route"
import { ModelsResponse } from "@/lib/harness/contract"

import type { TestDb } from "../../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "../setup"

let pg: TestDb
let token: string

const list = async () => (await models(call("GET", "/models", { token }))).json()
const tiers = (allowed: string) =>
  pg.query(`update kriya.plans set allowed_tiers = '${allowed}' where id = 'free'`)

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  ;({ token } = await deviceFor(pg, await db.createUser()))
})
beforeEach(async () => {
  harnessEnv({
    KRIYA_HARNESS_WORKFORCE: undefined,
    KRIYA_HARNESS_ORCHESTRA_HEAD: undefined,
    KRIYA_HARNESS_ORCHESTRA_WORKER: undefined,
  })
  await tiers("{budget,balanced,escalation}")
})

describe("WT-ORC-03: the orchestra advert", () => {
  it("off (the default): no orchestra field; the body is otherwise the same as with it on", async () => {
    const off = await list()
    expect(off).not.toHaveProperty("orchestra")
    harnessEnv({ KRIYA_HARNESS_WORKFORCE: "on" })
    const { orchestra, workforce, ...rest } = await list()
    expect(orchestra).toEqual({ head: "escalation", worker: "budget" })
    // W11: with workforce on, Kriya also advertises that it takes outcome counts
    expect(workforce).toBe(1)
    expect(rest).toEqual(off)
    ModelsResponse.parse({ ...rest, orchestra, workforce })
  })

  it("follows the owner's choice of levels", async () => {
    harnessEnv({
      KRIYA_HARNESS_WORKFORCE: "on",
      KRIYA_HARNESS_ORCHESTRA_HEAD: "balanced",
      KRIYA_HARNESS_ORCHESTRA_WORKER: "budget",
    })
    expect((await list()).orchestra).toEqual({ head: "balanced", worker: "budget" })
  })

  it("is withheld when the head and worker are the same level, or the plan lacks either", async () => {
    harnessEnv({
      KRIYA_HARNESS_WORKFORCE: "on",
      KRIYA_HARNESS_ORCHESTRA_HEAD: "budget",
      KRIYA_HARNESS_ORCHESTRA_WORKER: "budget",
    })
    expect(await list()).not.toHaveProperty("orchestra")
    harnessEnv({ KRIYA_HARNESS_WORKFORCE: "on" })
    await tiers("{budget,balanced}")
    expect(await list()).not.toHaveProperty("orchestra")
    await tiers("{balanced,escalation}")
    expect(await list()).not.toHaveProperty("orchestra")
  })

  it("an invalid setting value never reaches a device", async () => {
    harnessEnv({
      KRIYA_HARNESS_WORKFORCE: "on",
      KRIYA_HARNESS_ORCHESTRA_HEAD: "openai/gpt-5",
    })
    const body = await list()
    // getSetting falls back to the default when the value fails the pattern
    expect(body.orchestra === undefined || body.orchestra.head === "escalation").toBe(
      true
    )
  })
})
