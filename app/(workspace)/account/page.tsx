import type { Metadata } from "next"
import Link from "next/link"
import { asc, eq } from "drizzle-orm"

import { signOut } from "@/actions/auth"
import { listAboutYou } from "@/actions/memory"
import { AboutYou } from "@/components/account/about-you"
import {
  CancelPlanForm,
  DeleteAccountForm,
  LiteModeToggle,
  ProfileForm,
} from "@/components/account/forms"
import { Connections } from "@/components/account/connections"
import { connectionHealth } from "@/queries/connections"
import { Files } from "@/components/account/files"
import { Logins } from "@/components/account/logins"
import { Shares } from "@/components/account/shares"
import { PlanCards } from "@/components/account/plan-cards"
import { Notice } from "@/components/auth/auth-kit"
import { ResetForm } from "@/components/auth/forms"
import { StopAll } from "@/components/voice/controls"
import { PhoneSettings } from "@/components/voice/phone-settings"
import { privileged } from "@/db"
import { plans } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { billingProvider, currentSubscription } from "@/lib/billing"
import { getSetting } from "@/lib/config"
import { googleServices, isProviderConfigured, listConnections } from "@/lib/connectors"
import { usageSummary } from "@/lib/entitlements"
import { listFiles } from "@/lib/files"
import { listLogins } from "@/queries/logins"
import { listShares } from "@/lib/share"
import { formatInr } from "@/lib/money"
import { voiceAvailable } from "@/lib/voice/tasks"
import { getPhoneSettings } from "@/queries/voice"

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

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  notion: "Notion",
  github: "GitHub",
  meta: "Instagram",
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
  // A8: GitHub and Instagram cards, Sheets and YouTube options
  const connectorsV2 = (await getSetting("agents.connectors")) === "on"
  // Sheets alone, without the other A8 connectors
  const sheetsOn = (await getSetting("google.sheets")) === "on"
  const githubRow = accounts.find((a) => a.provider === "github")
  const metaRow = accounts.find((a) => a.provider === "meta")
  // G1: a dead token shows Reconnect; the Testing note while Google is in Testing
  const health = accounts.length ? await connectionHealth(user.id) : {}
  const testingMode = (await getSetting("google.testingMode")) === "on"
  const driveShare = (await getSetting("operator.driveShare")) === "on"
  const usage = await usageSummary(user.id)
  const subscription = await currentSubscription(user.id)
  const provider = billingProvider()
  const planRows = await privileged
    .select()
    .from(plans)
    .where(eq(plans.active, true))
    .orderBy(asc(plans.sort))
  const memoryV2 = (await getSetting("agents.memoryV2")) === "on"
  // A5: Files and Shared links
  const filesOn = (await getSetting("agents.files")) === "on"
  // A6: Logins (saved sign-ins by take-over)
  const loginsOn = (await getSetting("agents.loginProfiles")) === "on"
  // A7: the way into Accounts
  const ledgerOn = (await getSetting("agents.ledger")) === "on"
  // A13: the way into Radar and watchers
  const radarOn =
    (await getSetting("agents.radar")) === "on" ||
    (await getSetting("agents.watchers")) === "on"
  // Voice phase 7: "Phone & calls", with voice access only (UX spec §7)
  const voiceOn = await voiceAvailable(user.id)

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
              {PROVIDER_NAMES[connected] ?? "Notion"} is connected. Your agents can use it
              from their next task.
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
            {...(connectorsV2 && {
              more: {
                github: githubRow ? { account: githubRow.account } : null,
                meta: metaRow ? { account: metaRow.account } : null,
                available: {
                  github: isProviderConfigured("github"),
                  meta: isProviderConfigured("meta"),
                },
              },
            })}
            health={health}
            testingMode={testingMode}
            driveShare={driveShare}
            sheets={sheetsOn}
          />
        </Section>

        {voiceOn && (
          <Section
            id="phone"
            title="Phone & calls"
            description="Reminders and results come only as phone calls."
          >
            <PhoneSettings settings={await getPhoneSettings(user.id)} />
            <div className="flex justify-start">
              <StopAll />
            </div>
          </Section>
        )}

        {memoryV2 && (
          <Section
            id="about-you"
            title="About you"
            description="What all your agents know about you. You can add, pin, confirm or forget anything, and export it all."
          >
            <AboutYou initial={await listAboutYou()} />
          </Section>
        )}

        {ledgerOn && (
          <Section
            id="accounts"
            title="Accounts"
            description="Bills, income, GST invoices and an export for your CA. Prepared by Kriya from your records."
          >
            <Link
              href="/accounts"
              className="inline-flex min-h-11 w-fit items-center rounded-md border px-3 text-[13px] hover:bg-muted sm:min-h-8"
            >
              Open Accounts →
            </Link>
          </Section>
        )}

        {radarOn && (
          <Section
            id="radar"
            title="Radar"
            description="Deadlines with the exact words they came from, and the pages Kriya watches for you."
          >
            <Link
              href="/radar"
              className="inline-flex min-h-11 w-fit items-center rounded-md border px-3 text-[13px] hover:bg-muted sm:min-h-8"
            >
              Open Radar →
            </Link>
          </Section>
        )}

        {filesOn && (
          <Section
            id="files"
            title="Files"
            description="Bills, notes and documents your agents can read, and PDFs Kriya made for you. Stored privately; only you can open them."
          >
            <Files files={await listFiles(user.id)} />
          </Section>
        )}

        {loginsOn && (
          <Section
            id="logins"
            title="Logins"
            description="Sites you signed in to in Kriya's browser, so agents can work there as you within each site's rules. Kriya keeps the session, never your password."
          >
            <Logins logins={await listLogins(user.id)} />
          </Section>
        )}

        {filesOn && (
          <Section
            id="shared-links"
            title="Shared links"
            description="Read-only copies you shared. Each expires on its own; revoke one to stop it at once."
          >
            <Shares shares={await listShares(user.id)} />
          </Section>
        )}

        <Section id="profile" title="Profile">
          <ProfileForm profile={user.profile} />
        </Section>

        <Section id="display" title="Display">
          <LiteModeToggle chosen={user.profile.liteMode} />
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
