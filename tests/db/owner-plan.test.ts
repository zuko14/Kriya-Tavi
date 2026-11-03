import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270601000000_owner_plan.sql (owner, 2026-11-03): the platform owner is
// never asked to pay. The internal `owner` plan is never sold, and
// kriya.effective_plan_id gives it only to users whose platform role is
// owner, whatever they subscribe to; their harness spend is still metered.

let pg: TestDb
let owner: string
let person: string

const planOf = async (user: string) =>
  (await pg.query<{ id: string }>("select kriya.effective_plan_id($1) as id", [user]))
    .rows[0].id

const reserve = (user: string, microInr: number) =>
  pg.query(
    "select kriya.reserve_harness_spend($1, null, $2, 'escalation', 'm/test', $3)",
    [user, `req-${randomUUID()}`, microInr]
  )

beforeAll(async () => {
  pg = await createTestDb()
  owner = await createUser(pg)
  person = await createUser(pg)
  await pg.query(
    "insert into kriya.platform_roles (user_id, role) values ($1, 'owner')",
    [owner]
  )
})

describe("OWN-01: the owner plan", () => {
  it("is internal: never sold, never the default, every tier, no practical caps", async () => {
    const { rows } = await pg.query<{
      active: boolean
      is_default: boolean
      price_monthly_paise: string | null
      allowed_tiers: string[]
      harness_monthly_micro_inr: string
      included_usage_micro_inr: string
      voice_enabled: boolean
    }>("select * from kriya.plans where id = 'owner'")
    expect(rows[0]).toMatchObject({
      active: false,
      is_default: false,
      price_monthly_paise: null,
      voice_enabled: false,
    })
    expect(rows[0].allowed_tiers).toEqual(["budget", "balanced", "escalation"])
    expect(BigInt(rows[0].harness_monthly_micro_inr)).toBeGreaterThan(10n ** 14n)
    expect(BigInt(rows[0].included_usage_micro_inr)).toBeGreaterThan(10n ** 14n)
  })

  it("goes to owners only, ahead of a subscription; everyone else keeps theirs", async () => {
    expect(await planOf(owner)).toBe("owner")
    expect(await planOf(person)).toBe("free")
    await pg.query("update kriya.plans set active = true where id = 'pro'")
    await pg.query(
      `insert into kriya.subscriptions (user_id, plan_id, status, provider, provider_subscription_id)
       values ($1, 'pro', 'active', 'test', 'sub-owner'), ($2, 'pro', 'active', 'test', 'sub-person')`,
      [owner, person]
    )
    expect(await planOf(owner)).toBe("owner")
    expect(await planOf(person)).toBe("pro")
  })

  it("a person can't make themselves an owner", async () => {
    const stranger = await createUser(pg)
    await expect(
      asUser(pg, stranger, (tx) =>
        tx.query(
          "insert into kriya.platform_roles (user_id, role) values ($1, 'owner')",
          [stranger]
        )
      )
    ).rejects.toThrow()
    expect(await planOf(stranger)).toBe("free")
  })

  it("the harness never refuses an owner for the cap, and still records the spend", async () => {
    await reserve(owner, 50_000_000_000)
    await reserve(owner, 50_000_000_000)
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.harness_usage where user_id = $1",
      [owner]
    )
    expect(rows[0].n).toBe(2)
    // Someone on the free plan (cap 0) is still refused
    await expect(reserve(person, 1)).rejects.toThrow(
      /harness not in plan|harness cap reached/
    )
  })
})
