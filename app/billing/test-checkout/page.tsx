import type { Metadata } from "next"
import { and, eq } from "drizzle-orm"
import { notFound } from "next/navigation"

import { TestCheckoutForm } from "@/components/account/forms"
import { AuthCard } from "@/components/auth/auth-kit"
import { privileged } from "@/db"
import { plans, subscriptions } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { billingProvider } from "@/lib/billing"
import { formatPaise } from "@/lib/money"

export const metadata: Metadata = { title: "Test checkout" }

// Stands in for Razorpay's payment page while billing runs in test mode
export default async function TestCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ sub?: string }>
}) {
  const user = await requireUser()
  const { sub } = await searchParams
  if (billingProvider() !== "test" || !sub) notFound()
  const [row] = await privileged
    .select({
      status: subscriptions.status,
      plan: plans.name,
      price: plans.priceMonthlyPaise,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.provider, "test"),
        eq(subscriptions.providerSubscriptionId, sub)
      )
    )
  if (!row) notFound()
  return (
    <AuthCard
      title={`Kriya ${row.plan}: ${formatPaise(row.price)} / month`}
      subtitle="Test mode. No money moves: this page plays the payment provider, and the result goes through the same webhook processing as a real payment."
    >
      {row.status === "pending" ? (
        <TestCheckoutForm sub={sub} />
      ) : (
        <p className="text-[13px] text-muted-foreground">
          This checkout is already {row.status}.
        </p>
      )}
    </AuthCard>
  )
}
