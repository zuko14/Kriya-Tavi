import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// The harness ledger (track H, H3; HD-07, COST_AND_METERING, TEST_STRATEGY
// HT-MTR-01…05): the charge from the provider's cost with the plan's markup
// and the owner's rate (unpriced without it, never zero), the allowance
// counting harness charges exactly once, stale reservations estimated by the
// worker's janitor, the usage line equal to the ledger, the plan's cap saved.

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  requireOwner: async () => ({ id: state.user }),
}))

import { savePlan } from "@/actions/owner"
import { usageSummary } from "@/lib/entitlements"
import { harnessSpend } from "@/lib/harness/devices"
import { chargeFor, expireReservations } from "@/lib/harness/metering"
import { applyMarkup, usdToInr } from "@/lib/money"

import type { TestDb } from "../db/harness"
import { harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let user: string

const ledger = (
  rows: {
    key: string
    status: string
    reserved: number
    charge?: number | null
    at?: string
  }[]
) =>
  Promise.all(
    rows.map((r) =>
      pg.query(
        `insert into kriya.harness_usage (request_key, user_id, tier, model, status, reserved_micro_inr, charge_micro_inr, created_at)
         values ($1, $2, 'budget', 'test/budget', $3, $4, $5, coalesce($6::timestamptz, now()))`,
        [r.key, user, r.status, r.reserved, r.charge ?? null, r.at ?? null]
      )
    )
  )

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  user = await db.createUser()
  state.user = user
})
beforeEach(async () => {
  harnessEnv()
  await pg.query("delete from kriya.harness_usage")
})

describe("HT-MTR-01: the charge", () => {
  it("provider cost through the owner's rate and the plan's markup; estimate when unreported; unpriced without a rate", () => {
    expect(
      chargeFor({
        costMicroUsd: 123,
        estimateMicroUsd: 999,
        rateE4: 840000n,
        markupBps: 15000,
      })
    ).toEqual({
      chargeMicroInr: applyMarkup(usdToInr(123, 840000n), 15000),
      chargeStatus: "final",
    })
    expect(
      chargeFor({
        costMicroUsd: null,
        estimateMicroUsd: 999,
        rateE4: 840000n,
        markupBps: 15000,
      })
    ).toEqual({
      chargeMicroInr: applyMarkup(usdToInr(999, 840000n), 15000),
      chargeStatus: "estimated",
    })
    for (const unpriced of [
      { costMicroUsd: 123, estimateMicroUsd: 999, rateE4: null, markupBps: 15000 },
      { costMicroUsd: null, estimateMicroUsd: null, rateE4: 840000n, markupBps: 15000 },
    ])
      expect(chargeFor(unpriced)).toEqual({
        chargeMicroInr: null,
        chargeStatus: "unpriced",
      })
  })
})

describe("HT-MTR-02: the allowance counts harness charges exactly once", () => {
  it("adds charged and still-reserved rows, never failed ones; nothing else changes", async () => {
    const before = await usageSummary(user)
    await ledger([
      { key: "settled", status: "settled", reserved: 900, charge: 500 },
      { key: "reserved", status: "reserved", reserved: 300 },
      { key: "estimated", status: "estimated", reserved: 200, charge: 200 },
      { key: "failed", status: "failed", reserved: 9999 },
    ])
    const after = await usageSummary(user)
    expect(after.usedMicroInr - before.usedMicroInr).toBe(1000)
    expect({ ...after, usedMicroInr: 0, usedPct: null }).toEqual({
      ...before,
      usedMicroInr: 0,
      usedPct: null,
    })
    await pg.query("delete from kriya.harness_usage")
    expect(await usageSummary(user)).toEqual(before)
  })
})

describe("HT-MTR-03: the janitor estimates stale reservations", () => {
  it("older than 15 minutes → estimated at the reservation; fresh ones untouched", async () => {
    await ledger([
      {
        key: "stale",
        status: "reserved",
        reserved: 700,
        at: new Date(Date.now() - 20 * 60_000).toISOString(),
      },
      { key: "fresh", status: "reserved", reserved: 400 },
    ])
    expect(await expireReservations()).toBe(1)
    const { rows } = await pg.query(
      "select request_key, status, charge_micro_inr, charge_status from kriya.harness_usage order by request_key"
    )
    expect(rows).toEqual([
      {
        request_key: "fresh",
        status: "reserved",
        charge_micro_inr: null,
        charge_status: null,
      },
      {
        request_key: "stale",
        status: "estimated",
        charge_micro_inr: 700,
        charge_status: "estimated",
      },
    ])
  })
})

describe("HT-MTR-04 / -05: the usage line and the plan's cap", () => {
  it("the usage line's sum is the ledger's (IST month, failed excluded)", async () => {
    await ledger([
      { key: "a", status: "settled", reserved: 900, charge: 500 },
      { key: "b", status: "reserved", reserved: 300 },
      { key: "c", status: "failed", reserved: 50 },
      {
        key: "old",
        status: "settled",
        reserved: 5000,
        charge: 5000,
        at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      },
    ])
    expect(await harnessSpend(user)).toEqual({ used: 800, unpriced: 0 })
  })

  it("savePlan stores the harness limit in rupees as micro-INR", async () => {
    const { rows } = await pg.query<Record<string, unknown>>(
      "select * from kriya.plans where id = 'free'"
    )
    const plan = rows[0]
    const form = new FormData()
    const fields: Record<string, string> = {
      id: "free",
      name: String(plan.name),
      description: String(plan.description ?? ""),
      priceRupees: "",
      includedRupees: String(Number(plan.included_usage_micro_inr) / 1_000_000),
      markupBps: String(plan.markup_bps),
      maxAgents: String(plan.max_agents),
      maxConcurrentTasks: String(plan.max_concurrent_tasks),
      maxTasksPerDay: String(plan.max_tasks_per_day),
      maxTaskSeconds: String(plan.max_task_seconds),
      maxSteps: String(plan.max_steps),
      maxTaskCostCents: String(Number(plan.max_task_cost_micro_usd) / 10_000),
      workspaceMinutes: String(plan.workspace_minutes),
      harnessMonthlyInr: "500",
      overageCapRupees: "0",
      warnAtPct: String(plan.warn_at_pct),
      active: "on",
      razorpayPlanId: "",
    }
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    for (const tier of plan.allowed_tiers as string[]) form.append("allowedTiers", tier)
    expect(await savePlan(null, form)).toMatchObject({ message: expect.any(String) })
    expect(
      (
        await pg.query(
          "select harness_monthly_micro_inr from kriya.plans where id = 'free'"
        )
      ).rows
    ).toEqual([{ harness_monthly_micro_inr: 500000000 }])
  })
})
