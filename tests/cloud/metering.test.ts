import { spawnSync } from "node:child_process"

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { chargeTask } from "@/lib/agent/metering"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"
import { getCloudMinutes, getCloudOverview } from "@/queries/cloud"

import { createUser } from "../db/harness"
import { cloudDb } from "./db"
import { FakeProvider } from "./fake-provider"

// Compute metering (CD-14, TEST_STRATEGY CT-MTR-*): seconds per session in
// resource_usage, priced only from the owner's rate; kriya.charges for a
// workspace task are what its model usage alone gives; the usage page and
// the owner page add up the same rows.

const hasGit = spawnSync("git", ["--version"]).status === 0

const SETTINGS: CloudSettings = {
  image: "kriya-runner:test",
  size: "2c-4g",
  network: "registries",
  commandTimeoutSeconds: 60,
  maxRunning: 10,
  maxImportMb: 50,
  maxCheckpointMb: 10,
  costMicroUsdPerHour: null,
}

let db: Awaited<ReturnType<typeof cloudDb>>
let provider: FakeProvider

beforeAll(async () => {
  db = await cloudDb()
  process.env.KRIYA_FX_USD_INR = "84.2500"
})

beforeEach(() => {
  provider = new FakeProvider()
})

afterEach(async () => {
  await provider.closeAll()
})

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows[0]

// One workspace session of about `seconds`, ended normally
async function session(
  tag: string,
  seconds: number,
  settings = SETTINGS,
  userId = db.user
) {
  const t = await db.task(tag, userId)
  const ws = new TaskWorkspace(provider, t, settings, { store: null })
  await ws.open({})
  await db.pg.query(
    "update kriya.workspace_sessions set opened_at = now() - make_interval(secs => $2) where task_id = $1 and status = 'open'",
    [t.id, seconds]
  )
  await ws.close(null)
  return t
}

// The same model call on a task, as recordUsage writes it
const modelCall = (taskId: string, userId = db.user) =>
  db.pg.query(
    `insert into kriya.usage_events (request_key, user_id, task_id, attempt, step, provider, model, tier, input_tokens, output_tokens, usage_status, cost_micro_usd, cost_source)
     values ($1, $2, $3, 1, 1, 'openrouter', 'm/test', 'budget', 1000, 200, 'reported', 12345, 'provider')`,
    [`${taskId}:1:1`, userId, taskId]
  )

describe.skipIf(!hasGit)("compute metering", () => {
  it("CT-MTR-01: seconds per session; unpriced without the owner's rate (null, never 0)", async () => {
    const unpriced = await session("mtr01a", 600)
    const priced = await session("mtr01b", 600, {
      ...SETTINGS,
      costMicroUsdPerHour: 180_000,
    })
    const a = await one<{ quantity: number; cost_micro_usd: string | null }>(
      "select quantity, cost_micro_usd from kriya.resource_usage where task_id = $1 and kind = 'workspace_seconds'",
      [unpriced.id]
    )
    expect(a.quantity).toBeGreaterThanOrEqual(600)
    expect(a.cost_micro_usd).toBeNull()
    const b = await one<{ quantity: number; cost_micro_usd: string | null }>(
      "select quantity, cost_micro_usd from kriya.resource_usage where task_id = $1 and kind = 'workspace_seconds'",
      [priced.id]
    )
    expect(Number(b.cost_micro_usd)).toBe(Math.round((b.quantity * 180_000) / 3600))
    const s = await one<{ seconds: number }>(
      "select seconds from kriya.workspace_sessions where task_id = $1",
      [priced.id]
    )
    expect(s.seconds).toBe(b.quantity)
  })

  it("CT-MTR-02: a workspace task's charge is what its model usage alone gives", async () => {
    const withWorkspace = await session("mtr02a", 1800, {
      ...SETTINGS,
      costMicroUsdPerHour: 180_000,
    })
    const without = await db.task("mtr02b")
    await modelCall(withWorkspace.id)
    await modelCall(without.id)
    const a = await chargeTask({ ...withWorkspace, planId: "free" })
    const b = await chargeTask({ ...without, planId: "free" })
    expect(a).toEqual(b)
    const rows = await db.pg.query<{
      charge_micro_inr: string
      provider_cost_micro_usd: string
    }>(
      "select charge_micro_inr, provider_cost_micro_usd from kriya.charges where task_id = any($1) order by task_id",
      [[withWorkspace.id, without.id]]
    )
    expect(rows.rows[0]).toEqual(rows.rows[1])
  })

  it("CT-MTR-03: the usage page's minutes and the owner page's totals add up resource_usage", async () => {
    const other = await createUser(db.pg)
    await session("mtr03a", 300, { ...SETTINGS, costMicroUsdPerHour: 360_000 })
    await session("mtr03b", 900, SETTINGS, other)
    const mine = await one<{ s: string }>(
      "select coalesce(sum(quantity), 0) as s from kriya.resource_usage where user_id = $1 and kind = 'workspace_seconds'",
      [db.user]
    )
    const all = await one<{ s: string; c: string; u: string }>(
      `select coalesce(sum(quantity), 0) as s, coalesce(sum(cost_micro_usd), 0) as c,
              count(*) filter (where cost_micro_usd is null) as u
       from kriya.resource_usage where kind = 'workspace_seconds'`
    )
    const minutes = await getCloudMinutes(db.user)
    expect(minutes).toEqual({ usedSeconds: Number(mine.s), limitMinutes: 600 })
    const overview = await getCloudOverview()
    expect(overview.month).toMatchObject({
      seconds: Number(all.s),
      costMicroUsd: Number(all.c),
      unpricedSessions: Number(all.u),
    })
    const listed = overview.rows.filter((r) => r.userId === other)
    expect(listed.reduce((n, r) => n + r.seconds, 0)).toBeGreaterThanOrEqual(900)
  })
})
