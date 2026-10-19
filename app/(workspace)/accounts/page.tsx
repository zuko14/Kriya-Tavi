import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { eq, sql } from "drizzle-orm"

import {
  ConfirmDrafts,
  ConfirmWithNote,
  InvoiceActions,
} from "@/components/accounts/controls"
import { privileged } from "@/db"
import { plans } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { formatPaise } from "@/lib/money"
import { accountsOverview, listEntries, listInvoices } from "@/queries/ledger"

export const metadata: Metadata = { title: "Accounts" }

// Accounts (A7, UX_SPEC §9): this financial year's confirmed income,
// expenses and GST, entries waiting for the person, and invoices. Every
// number is a SQL sum of confirmed entries (AD-16).

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Kolkata",
})
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())

const STATUS: Record<string, string> = {
  draft: "border-hairline text-faint",
  issued: "border-rigel/40 text-rigel",
  paid: "border-ok/40 text-ok",
  void: "border-destructive/40 text-destructive line-through",
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-surface px-4 py-3">
      <span className="label-mono">{label}</span>
      <span className="font-mono text-xl tabular-nums">{value}</span>
      {note && <span className="text-[11.5px] text-muted-foreground">{note}</span>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export default async function AccountsPage() {
  const user = await requireUser()
  if ((await getSetting("agents.ledger")) !== "on") notFound()
  const [plan] = await privileged
    .select({ on: plans.ledgerEnabled })
    .from(plans)
    .where(eq(plans.id, sql`kriya.effective_plan_id(${user.id})`))

  const day = today()
  const overview = await accountsOverview(user.id, day)
  const [drafts, review, invoices] = await Promise.all([
    listEntries(user.id, { status: "draft" }, 100),
    listEntries(user.id, { status: "needs_review" }, 50),
    listInvoices(user.id, 50),
  ])
  const fy = (kind: string) => overview.fy.filter((s) => s.kind === kind)
  const sum = (
    rows: typeof overview.fy,
    pick: (r: (typeof overview.fy)[number]) => number
  ) => rows.reduce((a, r) => a + pick(r), 0)
  const gst = (r: (typeof overview.fy)[number]) => r.cgstPaise + r.sgstPaise + r.igstPaise
  const collected = sum(fy("income"), gst)
  const paid = sum(fy("expense"), gst)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1">
          <span className="label-mono">{"// accounts"}</span>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-[13px] text-muted-foreground">
            Prepared by Kriya from your records. Review with your CA. Only entries you
            confirm count.
          </p>
        </header>

        {!plan?.on && (
          <p className="rounded-lg border p-4 text-[13px]">
            Accounts aren&apos;t part of your plan yet.
          </p>
        )}

        <section aria-label="This financial year" className="flex flex-col gap-2">
          <span className="label-mono text-faint">financial year to date</span>
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
            <Stat
              label="income"
              value={formatPaise(sum(fy("income"), (r) => r.totalPaise))}
            />
            <Stat
              label="expenses"
              value={formatPaise(sum(fy("expense"), (r) => r.totalPaise))}
            />
            <Stat
              label="gst: collected − paid"
              value={formatPaise(collected - paid)}
              note={`${formatPaise(collected)} on income, ${formatPaise(paid)} on bills. An estimate, not a return.`}
            />
          </div>
        </section>

        <Section title={`Needs review (${overview.needsReview})`}>
          {review.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Nothing waiting.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border">
              {review.map((e) => (
                <li key={e.id} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[13.5px]">
                      {e.counterparty ?? "Unknown"}
                      {e.documentNo && (
                        <span className="text-faint"> · {e.documentNo}</span>
                      )}
                    </span>
                    <span className="font-mono text-[13px] tabular-nums">
                      {formatPaise(e.totalPaise)}
                    </span>
                  </div>
                  <ul className="flex flex-wrap gap-1.5" aria-label="Why">
                    {e.reviewReasons.map((reason) => (
                      <li
                        key={reason}
                        className="rounded-full border border-betelgeuse/40 px-2 py-0.5 text-[11.5px] text-betelgeuse"
                      >
                        {reason}
                      </li>
                    ))}
                  </ul>
                  <ConfirmWithNote id={e.id} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Ready to confirm (${drafts.length})`}>
          {drafts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No drafts.</p>
          ) : (
            <>
              <ul className="flex flex-col divide-y rounded-xl border">
                {drafts.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-baseline gap-x-3 px-3 py-2"
                  >
                    <span className="font-mono text-[11px] text-faint">
                      {DATE.format(new Date(e.entryDate))}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">
                      {e.kind === "income" ? "From " : ""}
                      {e.counterparty ?? "Unknown"}
                    </span>
                    <span className="font-mono text-[13px] tabular-nums">
                      {formatPaise(e.totalPaise)}
                    </span>
                  </li>
                ))}
              </ul>
              <ConfirmDrafts ids={drafts.map((e) => e.id)} />
            </>
          )}
        </Section>

        <Section title="Invoices">
          {invoices.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No invoices yet. Ask Lekha (or any agent with Accounts) to draft one.
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border">
              {invoices.map((inv) => (
                <li key={inv.id} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-[12.5px]">
                      {inv.numberText ?? "Draft"}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] ${STATUS[inv.status]}`}
                    >
                      {inv.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">
                      {inv.client.name}
                    </span>
                    <span className="font-mono text-[13px] tabular-nums">
                      {formatPaise(inv.totalPaise)}
                    </span>
                  </div>
                  <InvoiceActions
                    id={inv.id}
                    status={inv.status}
                    pdfFileId={inv.pdfFileId}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}
