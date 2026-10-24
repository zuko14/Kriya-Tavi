import { createHmac, timingSafeEqual } from "node:crypto"

import { and, desc, eq, inArray } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged } from "@/db"
import {
  billingEvents,
  payments,
  plans,
  subscriptions,
  type Plan,
  type SubscriptionStatus,
} from "@/db/schema"
import { getSecret } from "@/lib/config"
import { log } from "@/lib/log"

// Subscriptions and payments. A plan only becomes active from a verified
// provider event (a signed webhook), never from a browser redirect. Events
// are recorded once by their provider id, applied in one transaction, and an
// event older than the last one applied to a subscription is ignored.
//
// Providers: Razorpay (INR subscriptions, hosted payment page) and a test
// provider that drives the same event pipeline without moving money.

export type BillingProvider = "razorpay" | "test"

export function billingProvider(): BillingProvider | null {
  const chosen = process.env.KRIYA_BILLING_PROVIDER
  if (chosen === "razorpay") {
    return getSecret("RAZORPAY_KEY_ID") && getSecret("RAZORPAY_KEY_SECRET")
      ? "razorpay"
      : null
  }
  if (chosen === "test" || !chosen) {
    // Test billing is off in production unless deliberately allowed (staging)
    const allowed =
      process.env.NODE_ENV !== "production" ||
      process.env.KRIYA_ALLOW_TEST_BILLING === "1"
    return allowed ? "test" : null
  }
  return null
}

/* ───────────────────────────── events ───────────────────────────── */

// The subset of Razorpay's webhook payload Kriya reads. Test events use the
// same shape so both go through applyEvent.
export type SubscriptionEvent = {
  event: string
  created_at: number
  payload: {
    subscription?: {
      entity: {
        id: string
        status?: string
        plan_id?: string
        current_start?: number | null
        current_end?: number | null
        notes?: Record<string, string> | null
      }
    }
    payment?: {
      entity: {
        id: string
        amount: number
        currency: string
        status: string
        fee?: number | null
        tax?: number | null
        created_at?: number
      }
    }
  }
}

const STATUS_FOR: Record<string, SubscriptionStatus> = {
  "subscription.authenticated": "pending",
  "subscription.activated": "active",
  "subscription.charged": "active",
  "subscription.resumed": "active",
  "subscription.pending": "past_due",
  "subscription.halted": "halted",
  "subscription.paused": "halted",
  "subscription.cancelled": "canceled",
  "subscription.completed": "expired",
}

const seconds = (value: number | null | undefined) =>
  value ? new Date(value * 1000) : null

export type ApplyResult = "applied" | "duplicate" | "stale" | "ignored"

export async function applyEvent(
  provider: BillingProvider,
  eventId: string,
  event: SubscriptionEvent
): Promise<ApplyResult> {
  return privileged.transaction(async (tx) => {
    const [recorded] = await tx
      .insert(billingEvents)
      .values({ provider, eventId, type: event.event, payload: event })
      .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.eventId] })
      .returning({ id: billingEvents.id })
    if (!recorded) return "duplicate"
    const done = (result: ApplyResult, error?: string) =>
      tx
        .update(billingEvents)
        .set({ processedAt: new Date(), error: error ?? null })
        .where(eq(billingEvents.id, recorded.id))
        .then(() => result)

    const status = STATUS_FOR[event.event]
    const entity = event.payload.subscription?.entity
    if (!status || !entity) return done("ignored")
    const at = new Date(event.created_at * 1000)

    let [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.provider, provider),
          eq(subscriptions.providerSubscriptionId, entity.id)
        )
      )
      .for("update")
    if (!sub) {
      // The webhook beat our own record of the checkout: rebuild it from the
      // notes we attached when creating the subscription
      const userId = entity.notes?.user_id
      const planId = entity.notes?.plan_id
      if (!userId || !planId) return done("ignored", "unknown subscription")
      ;[sub] = await tx
        .insert(subscriptions)
        .values({
          userId,
          planId,
          status: "pending",
          provider,
          providerSubscriptionId: entity.id,
        })
        .returning()
    }
    // A charge is a fact whatever order its event arrives in: record it before
    // the stale check (which only protects the subscription's status)
    const payment = event.payload.payment?.entity
    if (payment && event.event === "subscription.charged") {
      await tx
        .insert(payments)
        .values({
          userId: sub.userId,
          subscriptionId: sub.id,
          provider,
          providerPaymentId: payment.id,
          amountPaise: payment.amount,
          feePaise: payment.fee ?? null,
          taxPaise: payment.tax ?? null,
          currency: payment.currency,
          status: payment.status === "captured" ? "captured" : "failed",
          paidAt: seconds(payment.created_at) ?? at,
        })
        .onConflictDoNothing({ target: [payments.provider, payments.providerPaymentId] })
    }
    if (sub.lastEventAt && at < sub.lastEventAt) return done("stale")

    await tx
      .update(subscriptions)
      .set({
        status,
        lastEventAt: at,
        currentPeriodStart: seconds(entity.current_start) ?? sub.currentPeriodStart,
        currentPeriodEnd: seconds(entity.current_end) ?? sub.currentPeriodEnd,
      })
      .where(eq(subscriptions.id, sub.id))

    return done("applied")
  })
}

/* ──────────────────────────── razorpay ──────────────────────────── */

export function verifyRazorpaySignature(rawBody: string, signature: string | null) {
  const secret = getSecret("RAZORPAY_WEBHOOK_SECRET")
  if (!secret || !signature) return false
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function razorpay<T>(path: string, body: unknown): Promise<T> {
  const key = getSecret("RAZORPAY_KEY_ID")
  const secret = getSecret("RAZORPAY_KEY_SECRET")
  if (!key || !secret) throw new Error("Razorpay is not configured.")
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await response.json().catch(() => null)) as T & {
    error?: { description?: string }
  }
  if (!response.ok) {
    throw new Error(json?.error?.description ?? `Razorpay answered ${response.status}`)
  }
  return json
}

/* ───────────────────────────── checkout ─────────────────────────── */

export async function currentSubscription(userId: string) {
  const [sub] = await privileged
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ["pending", "active", "past_due", "halted"])
      )
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1)
  return sub ?? null
}

// Returns where to send the person to pay
export async function startCheckout(
  userId: string,
  plan: Plan
): Promise<{ url: string }> {
  const provider = billingProvider()
  if (!provider) throw new Error("Paid plans aren't available yet.")
  if (!plan.active || !plan.priceMonthlyPaise || plan.isDefault) {
    throw new Error("That plan isn't available.")
  }
  const existing = await currentSubscription(userId)
  if (existing && existing.status !== "pending") {
    throw new Error("You already have a subscription. Cancel it before switching plans.")
  }

  if (provider === "razorpay") {
    if (!plan.razorpayPlanId) throw new Error("That plan isn't set up for payments yet.")
    const created = await razorpay<{ id: string; short_url: string }>("/subscriptions", {
      plan_id: plan.razorpayPlanId,
      total_count: 120,
      customer_notify: 1,
      notes: { user_id: userId, plan_id: plan.id },
    })
    await privileged.insert(subscriptions).values({
      userId,
      planId: plan.id,
      status: "pending",
      provider,
      providerSubscriptionId: created.id,
    })
    return { url: created.short_url }
  }

  const id = `test_sub_${nanoid(14)}`
  await privileged.insert(subscriptions).values({
    userId,
    planId: plan.id,
    status: "pending",
    provider,
    providerSubscriptionId: id,
  })
  return { url: `/billing/test-checkout?sub=${id}` }
}

// The test provider's stand-in for a payment: emits the events Razorpay
// would, through the same applyEvent path
export async function simulateTestPayment(
  userId: string,
  subscriptionId: string,
  outcome: "paid" | "failed"
) {
  if (billingProvider() !== "test") throw new Error("Test billing is off.")
  const [sub] = await privileged
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.provider, "test"),
        eq(subscriptions.providerSubscriptionId, subscriptionId)
      )
    )
  if (!sub) throw new Error("Checkout not found.")
  const [plan] = await privileged.select().from(plans).where(eq(plans.id, sub.planId))
  const now = Math.floor(Date.now() / 1000)
  const entity = {
    id: sub.providerSubscriptionId,
    current_start: now,
    current_end: now + 30 * 24 * 60 * 60,
    notes: { user_id: userId, plan_id: sub.planId },
  }
  if (outcome === "failed") {
    return applyEvent("test", `test_evt_${nanoid(12)}`, {
      event: "subscription.halted",
      created_at: now,
      payload: { subscription: { entity } },
    })
  }
  await applyEvent("test", `test_evt_${nanoid(12)}`, {
    event: "subscription.activated",
    created_at: now,
    payload: { subscription: { entity } },
  })
  return applyEvent("test", `test_evt_${nanoid(12)}`, {
    event: "subscription.charged",
    created_at: now + 1,
    payload: {
      subscription: { entity },
      payment: {
        entity: {
          id: `test_pay_${nanoid(12)}`,
          amount: plan?.priceMonthlyPaise ?? 0,
          currency: "INR",
          status: "captured",
          created_at: now + 1,
        },
      },
    },
  })
}

export async function cancelSubscription(userId: string, atPeriodEnd = true) {
  const sub = await currentSubscription(userId)
  if (!sub) return null
  if (sub.provider === "razorpay") {
    await razorpay(`/subscriptions/${sub.providerSubscriptionId}/cancel`, {
      cancel_at_cycle_end: atPeriodEnd ? 1 : 0,
    })
    // The provider's webhook sets the final status; until then, flag it
    await privileged
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: atPeriodEnd })
      .where(eq(subscriptions.id, sub.id))
  } else {
    await privileged
      .update(subscriptions)
      .set(
        atPeriodEnd && sub.status === "active"
          ? { cancelAtPeriodEnd: true }
          : { status: "canceled", cancelAtPeriodEnd: false }
      )
      .where(eq(subscriptions.id, sub.id))
  }
  log.info("subscription cancel requested", { subscriptionId: sub.id, atPeriodEnd })
  return sub
}
