import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Own models (docs/kriya-harness/OWN_MODELS.md), HT-OWN-*: POST /own-usage
// takes counts only, scoped to the device's person; 404 while
// harness.ownModels is off; /models advertises ownModels only when on.

vi.mock("server-only", () => ({}))

import { GET as models } from "@/app/api/harness/v1/models/route"
import { POST as ownUsage } from "@/app/api/harness/v1/own-usage/route"
import { ModelsResponse } from "@/lib/harness/contract"
import { ownUsageThisMonth, ownUsageTotals } from "@/lib/harness/own-usage"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let alice: string
let bob: string
let aliceToken: string
let bobToken: string

const entry = (over: Record<string, unknown> = {}) => ({
  provider: "openrouter",
  model: "deepseek/deepseek-chat",
  requests: 3,
  inputTokens: 1200,
  outputTokens: 300,
  ...over,
})
const send = (token: string, body: unknown) =>
  ownUsage(call("POST", "/own-usage", { token, body }))

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  alice = await db.createUser()
  bob = await db.createUser()
  ;({ token: aliceToken } = await deviceFor(pg, alice))
  ;({ token: bobToken } = await deviceFor(pg, bob))
})
beforeEach(async () => {
  harnessEnv({ KRIYA_HARNESS_OWN_MODELS: undefined })
  await pg.query("delete from kriya.harness_own_usage")
})

describe("HT-OWN-01: off means nothing", () => {
  it("404 and no row; /models has no ownModels", async () => {
    expect((await send(aliceToken, { entries: [entry()] })).status).toBe(404)
    expect((await pg.query("select 1 from kriya.harness_own_usage")).rows).toHaveLength(0)
    expect(
      await (await models(call("GET", "/models", { token: aliceToken }))).json()
    ).not.toHaveProperty("ownModels")
  })
})

describe("HT-OWN-02: on", () => {
  beforeEach(() => harnessEnv({ KRIYA_HARNESS_OWN_MODELS: "on" }))

  it("advertises ownModels, valid by the contract", async () => {
    const body = await (
      await models(call("GET", "/models", { token: aliceToken }))
    ).json()
    expect(body.ownModels).toBe(1)
    ModelsResponse.parse(body)
  })

  it("records counts for the device's own person; each sees only their own", async () => {
    expect(
      (
        await send(aliceToken, {
          entries: [
            entry(),
            entry({ model: "openai/gpt-x", reportedCostMicroUsd: 2500 }),
          ],
        })
      ).status
    ).toBe(204)
    expect((await send(bobToken, { entries: [entry({ requests: 9 })] })).status).toBe(204)
    const mine = await ownUsageThisMonth(alice)
    expect(
      mine
        .map((r) => [
          r.model,
          r.requests,
          r.inputTokens,
          r.outputTokens,
          r.reportedCostMicroUsd,
        ])
        .sort()
    ).toEqual(
      [
        ["deepseek/deepseek-chat", 3, 1200, 300, null],
        ["openai/gpt-x", 3, 1200, 300, 2500],
      ].sort()
    )
    expect((await ownUsageThisMonth(bob))[0].requests).toBe(9)
    const all = await ownUsageTotals()
    const chat = all.find((r) => r.model === "deepseek/deepseek-chat")!
    expect([chat.requests, chat.people]).toEqual([12, 2])
  })

  it("refuses anything beyond counts: text, keys, unknown fields, bad providers, too many", async () => {
    for (const bad of [
      { entries: [{ ...entry(), prompt: "secret code" }] },
      { entries: [{ ...entry(), apiKey: "sk-123" }] },
      { entries: [entry({ provider: "Open Router!" })] },
      { entries: [entry({ inputTokens: -1 })] },
      { entries: Array.from({ length: 51 }, () => entry()) },
      { entries: [] },
    ])
      expect((await send(aliceToken, bad)).status).toBe(400)
    expect((await pg.query("select 1 from kriya.harness_own_usage")).rows).toHaveLength(0)
  })

  it("needs a device token", async () => {
    expect(
      (await ownUsage(call("POST", "/own-usage", { body: { entries: [entry()] } })))
        .status
    ).toBe(401)
  })
})
