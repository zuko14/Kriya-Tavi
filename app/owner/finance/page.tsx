import type { Metadata } from "next"
import Link from "next/link"

import { Bars, Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { formatInr, formatPaise, formatUsd } from "@/lib/money"
import { finance } from "@/lib/owner"

export const metadata: Metadata = { title: "Finance" }

export default async function OwnerFinance() {
  await requireOwner()
  const f = await finance(30)
  const totalCost = f.usage.reported + f.usage.estimated
  const perTask = f.taskCosts.tasks ? Math.round(totalCost / f.taskCosts.tasks) : 0
  const perSuccess = f.taskCosts.succeeded
    ? Math.round(totalCost / f.taskCosts.succeeded)
    : 0
  const e = f.estimate

  const breakdown: [string, string][] = [
    ["Revenue (captured payments)", formatInr(e.revenueMicroInr)],
    [
      `Payment fees${e.feesFromProvider ? " (reported by provider)" : " (finance.paymentFeeBps)"}`,
      e.feeMicroInr == null ? "not set" : `− ${formatInr(e.feeMicroInr)}`,
    ],
    [
      "Provider cost in INR (reported + estimated, at the FX rate)",
      e.providerCostMicroInr == null
        ? "FX rate not set"
        : `− ${formatInr(e.providerCostMicroInr)}`,
    ],
    [
      `Infrastructure (finance.infraMonthlyInr, pro-rated to ${f.days} days)`,
      e.infraMicroInr == null ? "not set" : `− ${formatInr(e.infraMicroInr)}`,
    ],
    ["Taxes collected (reported by provider, excluded above)", formatInr(e.taxMicroInr)],
    [
      "Estimated contribution",
      e.contribution == null ? "incomplete assumptions" : formatInr(e.contribution),
    ],
  ]

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Finance · last {f.days} days
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Three different things, never mixed: what providers <strong>reported</strong>{" "}
          they charged, what Kriya <strong>estimated</strong> where they didn&apos;t
          report, and what customers were <strong>charged</strong>. FX:{" "}
          {f.fx.rate
            ? `₹${f.fx.rate} per USD (${f.fx.source ?? "source not set"})`
            : "not set"}
          .
        </p>
      </header>

      <Tiles>
        <Tile label="provider cost · reported" value={formatUsd(f.usage.reported)} />
        <Tile
          label="provider cost · estimated"
          value={formatUsd(f.usage.estimated)}
          tone={f.usage.estimated > 0 ? "warn" : undefined}
          hint="where no cost was reported"
        />
        <Tile
          label="unmetered calls"
          value={f.usage.unmetered}
          tone={f.usage.unmetered > 0 ? "bad" : "good"}
          hint={`${f.usage.missingUsage} with no token usage`}
        />
        <Tile label="customer charges" value={formatInr(f.taskCosts.charged)} />
        <Tile
          label="cost / task"
          value={formatUsd(perTask)}
          hint={`${f.taskCosts.tasks} tasks`}
        />
        <Tile
          label="cost / successful task"
          value={formatUsd(perSuccess)}
          hint={`${f.taskCosts.succeeded} succeeded`}
        />
        <Tile
          label="tokens"
          value={(f.usage.inputTokens + f.usage.outputTokens).toLocaleString("en-IN")}
          hint={`${f.usage.calls} model calls`}
        />
        <Tile
          label="retry overhead"
          value={formatUsd(f.usage.retryCost)}
          hint="cost of attempts after the first"
        />
      </Tiles>

      <Section
        title="Provider cost per day"
        description="Teal: reported by the provider. Terracotta: Kriya's estimate."
      >
        <Bars
          label="Provider cost per day"
          data={f.daily.map((day) => ({
            key: day.day,
            a: day.reported,
            b: day.estimated,
            title: `${day.day}: ${formatUsd(day.reported)} reported, ${formatUsd(day.estimated)} estimated`,
          }))}
        />
      </Section>

      <Section
        title="Contribution estimate"
        description="An estimate, not accounting. Assumptions are listed; set them in Config."
      >
        <div className="grid gap-px overflow-hidden rounded-xl border bg-border text-[13px] sm:grid-cols-2">
          {breakdown.map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-3 bg-surface px-4 py-2.5"
            >
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono tabular-nums">{value}</span>
            </div>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {f.revenue.payments} payment(s) worth {formatPaise(f.revenue.amount)}. Charges
          marked estimated: {f.taskCosts.estimatedCharges}. Unpriced (no FX rate at the
          time): {f.taskCosts.unpriced}. Finished tasks without a charge record:{" "}
          {f.taskCosts.uncharged}.{" "}
          <Link href="/owner/operations" className="text-rigel hover:underline">
            Reconcile →
          </Link>
        </p>
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="By model">
          <Table head={["model", "calls", "tokens", "cost", "latency"]}>
            {f.byModel.length === 0 && <Empty colSpan={5}>No model calls yet.</Empty>}
            {f.byModel.map((row) => (
              <tr key={row.model}>
                <Td className="font-mono text-[11.5px]">{row.model}</Td>
                <Td className="font-mono tabular-nums">{row.calls}</Td>
                <Td className="font-mono tabular-nums">
                  {row.tokens.toLocaleString("en-IN")}
                </Td>
                <Td className="font-mono tabular-nums">{formatUsd(row.cost)}</Td>
                <Td className="font-mono tabular-nums">{row.avgLatency}ms</Td>
              </tr>
            ))}
          </Table>
        </Section>
        <Section title="By plan">
          <Table head={["plan", "tasks", "provider cost", "charged"]}>
            {f.byPlan.length === 0 && <Empty colSpan={4}>No charges yet.</Empty>}
            {f.byPlan.map((row) => (
              <tr key={row.planId ?? "none"}>
                <Td className="font-mono">{row.planId ?? "—"}</Td>
                <Td className="font-mono tabular-nums">{row.tasks}</Td>
                <Td className="font-mono tabular-nums">{formatUsd(row.providerCost)}</Td>
                <Td className="font-mono tabular-nums">{formatInr(row.charged)}</Td>
              </tr>
            ))}
          </Table>
        </Section>
      </div>

      <Section title="Top users by provider cost">
        <Table head={["user", "tasks", "provider cost", "charged"]}>
          {f.topUsers.length === 0 && <Empty colSpan={4}>No usage yet.</Empty>}
          {f.topUsers.map((row) => (
            <tr key={row.userId ?? "deleted"}>
              <Td>
                {row.userId ? (
                  <Link
                    href={`/owner/users/${row.userId}`}
                    className="text-rigel hover:underline"
                  >
                    {row.email ?? row.userId}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">deleted account</span>
                )}
              </Td>
              <Td className="font-mono tabular-nums">{row.tasks}</Td>
              <Td className="font-mono tabular-nums">{formatUsd(row.providerCost)}</Td>
              <Td className="font-mono tabular-nums">{formatInr(row.charged)}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  )
}
