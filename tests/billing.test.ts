import { createHmac } from "node:crypto"

import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import {
  applyEvent,
  verifyRazorpaySignature,
  type SubscriptionEvent,
} from "@/lib/billing"

import { createTestDb, createUser, type TestDb } from "./db/harness"

let pg: TestDb
let user: string

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
})

const t0 = 1_800_000_000
function event(
  name: string,
  at: number,
  extra: Partial<SubscriptionEvent["payload"]> = {}
) {
  return {
    event: name,
    created_at: at,
    payload: {
      subscription: {
        entity: {
          id: "sub_1",
          current_start: at,
          current_end: at + 30 * 86400,
          notes: { user_id: user, plan_id: "pro" },
        },
      },
      ...extra,
    },
  } satisfies SubscriptionEvent
}

async function subscription() {
  const { rows } = await pg.query<{ status: string }>(
    "select status from kriya.subscriptions where provider_subscription_id = 'sub_1'"
  )
  return rows[0]?.status
}

async function plan() {
  const { rows } = await pg.query<{ p: string }>(
    "select kriya.effective_plan_id($1) as p",
    [user]
  )
  return rows[0].p
}

describe("billing events", () => {
  it("activates a plan only from a provider event", async () => {
    expect(await plan()).toBe("free")
    // The checkout created no row yet: the notes rebuild it
    expect(
      await applyEvent("razorpay", "evt_1", event("subscription.activated", t0))
    ).toBe("applied")
    expect(await subscription()).toBe("active")
  })

  it("ignores a duplicate delivery", async () => {
    await applyEvent("razorpay", "evt_1", event("subscription.activated", t0))
    expect(
      await applyEvent("razorpay", "evt_1", event("subscription.cancelled", t0 + 5))
    ).toBe("duplicate")
    expect(await subscription()).toBe("active")
  })

  it("ignores events older than the last one applied", async () => {
    await applyEvent("razorpay", "evt_2", event("subscription.cancelled", t0 + 100))
    expect(
      await applyEvent("razorpay", "evt_1", event("subscription.activated", t0))
    ).toBe("stale")
    expect(await subscription()).toBe("canceled")
  })

  it("records each payment once", async () => {
    const payment = {
      payment: {
        entity: {
          id: "pay_1",
          amount: 49900,
          currency: "INR",
          status: "captured",
          created_at: t0,
        },
      },
    }
    await applyEvent("razorpay", "evt_1", event("subscription.charged", t0, payment))
    await applyEvent("razorpay", "evt_2", event("subscription.charged", t0 + 1, payment))
    const { rows } = await pg.query<{ n: number; total: string }>(
      "select count(*)::int as n, sum(amount_paise)::text as total from kriya.payments"
    )
    expect(rows[0]).toEqual({ n: 1, total: "49900" })
  })

  it("drops to the free plan when the subscription ends", async () => {
    const now = Math.floor(Date.now() / 1000)
    await applyEvent("razorpay", "evt_1", event("subscription.activated", now))
    expect(await plan()).toBe("pro")
    await applyEvent("razorpay", "evt_2", event("subscription.halted", now + 10))
    expect(await plan()).toBe("free")
  })

  it("leaves unknown subscriptions without notes alone", async () => {
    const orphan = event("subscription.activated", t0)
    orphan.payload.subscription.entity.notes = {} as never
    expect(await applyEvent("razorpay", "evt_1", orphan)).toBe("ignored")
  })
})

describe("razorpay signatures", () => {
  it("accepts only an HMAC of the exact body with the webhook secret", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test"
    const body = JSON.stringify({ event: "subscription.activated" })
    const good = createHmac("sha256", "whsec_test").update(body).digest("hex")
    expect(verifyRazorpaySignature(body, good)).toBe(true)
    expect(verifyRazorpaySignature(body + " ", good)).toBe(false)
    expect(verifyRazorpaySignature(body, good.replace(/.$/, "0"))).toBe(false)
    expect(verifyRazorpaySignature(body, null)).toBe(false)
    delete process.env.RAZORPAY_WEBHOOK_SECRET
    expect(verifyRazorpaySignature(body, good)).toBe(false)
  })
})
