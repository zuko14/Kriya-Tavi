import type { Metadata } from "next"
import { asc, eq } from "drizzle-orm"

import { signOut } from "@/actions/auth"
import {
  CancelPlanForm,
  DeleteAccountForm,
  ProfileForm,
} from "@/components/account/forms"
import { Connections } from "@/components/account/connections"
import { PlanCards } from "@/components/account/plan-cards"
import { Notice } from "@/components/auth/auth-kit"
import { ResetForm } from "@/components/auth/forms"
import { privileged } from "@/db"
import { plans } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { billingProvider, currentSubscription } from "@/lib/billing"
import { googleServices, isProviderConfigured, listConnections } from "@/lib/connectors"
import { usageSummary } from "@/lib/entitlements"
import { formatInr } from "@/lib/money"

export const metadata: Metadata = { title: "Account" }

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      className="flex scroll-mt-6 flex-col gap-4 border-t pt-8 first:border-t-0 first:pt-0"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        )}
      </header>
      {children}
    </section>
  )
}

const CONNECT_ERRORS: Record<string, string> = {
  denied: "You didn't allow access, so nothing was connected.",
  expired: "That attempt expired. Try connecting again.",
  unavailable: "Connecting accounts isn't set up on this server yet.",
  failed: "Couldn't finish connecting. Try again in a moment.",
  unknown: "That isn't something Kriya can connect to.",
}

const dateFormat: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string; connected?: string; connect_error?: string }>
}) {
  const user = await requireUser()
  const { billing, connected, connect_error: connectError } = await searchParams
  const accounts = await listConnections(user.id)
  const googleRow = accounts.find((a) => a.provider === "google")
  const notionRow = accounts.find((a) => a.provider === "notion")
  const usage = await usageSummary(user.id)
  const subscription = await currentSubscription(user.id)
  const provider = billingProvider()
  const planRows = await privileged
    .select()
    .from(plans)
    .where(eq(plans.active, true))
    .orderBy(asc(plans.sort))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1">
          <span className="label-mono">{"// account"}</span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {user.profile.displayName ?? "Your account"}
          </h1>
          <p className="text-[13px] text-muted-foreground">{user.email}</p>
        </header>

        {billing === "active" && (
          <Notice tone="success">Payment confirmed. Your new plan is active.</Notice>
        )}
        {billing === "failed" && (
          <Notice tone="error">
            The payment didn&apos;t go through. You&apos;re still on {usage.plan.name}.
          </Notice>
        )}

        <Section
          id="plan"
          title="Plan and usage"
          description={`You're on ${usage.plan.name}. Usage resets on your billing date, or on the 1st of each month on Free.`}
        >
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
            <div className="flex flex-col gap-1 bg-surface px-4 py-3">
              <span className="label-mono">tasks today</span>
              <span className="font-mono text-xl tabular-nums">
                {usage.tasksToday} / {usage.plan.maxTasksPerDay}
              </span>
            </div>
            <div className="flex flex-col gap-1 bg-surface px-4 py-3">
              <span className="label-mono">used this period</span>
              <span className="font-mono text-xl tabular-nums">
                {formatInr(usage.usedMicroInr)}
              </span>
            </div>
            <div className="col-span-2 flex flex-col gap-1 bg-surface px-4 py-3 sm:col-span-1">
              <span className="label-mono">included</span>
              <span className="font-mono text-xl tabular-nums">
                {usage.allowanceMicroInr > 0
                  ? formatInr(usage.allowanceMicroInr)
                  : "Task limit only"}
              </span>
            </div>
          </div>
          {subscription && (
            <div className="flex flex-col gap-2 rounded-lg border p-4 text-[13px]">
              <span>
                Subscription:{" "}
                <strong className="font-medium">{subscription.status}</strong>
                {subscription.currentPeriodEnd &&
                  ` · ${subscription.cancelAtPeriodEnd ? "ends" : "renews"} ${subscription.currentPeriodEnd.toLocaleDateString("en-IN", dateFormat)}`}
                {subscription.provider === "test" && " · test mode, no money moved"}
              </span>
              {!subscription.cancelAtPeriodEnd && subscription.status === "active" && (
                <CancelPlanForm />
              )}
            </div>
          )}
          <PlanCards
            plans={planRows}
            currentPlanId={usage.plan.id}
            canBuy={!!provider && !subscription}
            signedIn
          />
          {!provider && (
            <p className="text-[12.5px] text-muted-foreground">Paid plans open soon.</p>
          )}
          {provider === "test" && (
            <p className="text-[12.5px] text-muted-foreground">
              Payments are in test mode: choosing a plan opens a simulated checkout.
            </p>
          )}
        </Section>

        <Section
          id="connections"
          title="Connected accounts"
          description="Let your agents use your calendar, email and documents. Anything that changes your accounts waits for your approval first."
        >
          {connected && (
            <Notice tone="success">
              {connected === "google" ? "Google" : "Notion"} is connected. Your agents can
              use it from their next task.
            </Notice>
          )}
          {connectError && (
            <Notice tone="error">
              {CONNECT_ERRORS[connectError] ?? CONNECT_ERRORS.failed}
            </Notice>
          )}
          <Connections
            google={
              googleRow
                ? {
                    account: googleRow.account,
                    services: googleServices(googleRow.scopes),
                  }
                : null
            }
            notion={notionRow ? { account: notionRow.account } : null}
            available={{
              google: isProviderConfigured("google"),
              notion: isProviderConfigured("notion"),
            }}
          />
        </Section>

        <Section id="profile" title="Profile">
          <ProfileForm profile={user.profile} />
        </Section>

        <Section id="security" title="Password">
          <div className="max-w-sm">
            <ResetForm from="account" />
          </div>
        </Section>

        <Section id="session" title="Session">
          <form action={signOut}>
            <button type="submit" className="text-[13px] text-rigel hover:underline">
              Sign out of this device
            </button>
          </form>
        </Section>

        <Section id="delete" title="Delete account">
          <DeleteAccountForm />
        </Section>
      </div>
    </div>
  )
}
