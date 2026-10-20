import type { Metadata } from "next"
import Link from "next/link"

import { Bars, Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { formatInr, formatPaise, formatUsd } from "@/lib/money"
import { finance, voiceFinance } from "@/lib/owner"

export const metadata: Metadata = { title: "Finance" }

export default async function OwnerFinance() {
  await requireOwner()
  const f = await finance(30)
  const v = await voiceFinance(30)
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

      <Section
        title="Phone calls"
        description="Voice cost in INR: reported by providers, or estimated from your voice price sheet. Unmetered items have no price yet and are never counted as free."
      >
        {v.unpricedToday > 0 && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 px-3 py-2 text-[13px] text-destructive"
          >
            {v.unpricedToday} voice charge(s) today have unpriced items. Add the prices in{" "}
            <Link href="/owner/config" className="underline">
              Config
            </Link>
            .
          </p>
        )}
        <Tiles>
          <Tile
            label="voice provider cost"
            value={formatInr(v.costMicroInr)}
            hint={`${v.tasks} finished tasks`}
          />
          <Tile
            label="cost / successful call task"
            value={
              v.costPerSuccessMicroInr == null ? "—" : formatInr(v.costPerSuccessMicroInr)
            }
            hint={`${v.successful} completed, not call_failed`}
          />
          <Tile label="customer charges" value={formatInr(v.chargedMicroInr)} />
          <Tile
            label="contribution"
            value={
              v.contributionMicroInr == null
                ? "fee not set"
                : formatInr(v.contributionMicroInr)
            }
            hint="charges − cost − finance.paymentFeeBps"
          />
          <Tile
            label="failed attempts"
            value={
              v.failed.microInr == null ? "FX rate not set" : formatInr(v.failed.microInr)
            }
            hint={`${v.failed.attempts} busy / unanswered / failed · ${v.failed.unmetered} unmetered`}
            tone={v.failed.unmetered > 0 ? "warn" : undefined}
          />
          <Tile
            label="attempts / task"
            value={v.attemptsPerTask == null ? "—" : v.attemptsPerTask.toFixed(2)}
          />
          <Tile
            label="unpriced tasks"
            value={v.unpricedTasks}
            tone={v.unpricedTasks > 0 ? "bad" : "good"}
          />
        </Tiles>
        <Table
          head={[
            "component",
            "provider",
            "items",
            "cost",
            "reported",
            "estimated",
            "unmetered",
          ]}
        >
          {v.byComponent.length === 0 && <Empty colSpan={7}>No voice usage yet.</Empty>}
          {v.byComponent.map((row) => (
            <tr key={`${row.component}:${row.provider}`}>
              <Td>{row.component}</Td>
              <Td className="font-mono text-[11.5px]">{row.provider}</Td>
              <Td className="font-mono tabular-nums">{row.items}</Td>
              <Td className="font-mono tabular-nums">
                {row.microInr == null ? "FX rate not set" : formatInr(row.microInr)}
              </Td>
              <Td className="font-mono tabular-nums">
                {row.items - row.estimated - row.unmetered}
              </Td>
              <Td className="font-mono tabular-nums">{row.estimated}</Td>
              <Td
                className={
                  row.unmetered > 0
                    ? "font-mono text-destructive tabular-nums"
                    : "font-mono tabular-nums"
                }
              >
                {row.unmetered}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>

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
