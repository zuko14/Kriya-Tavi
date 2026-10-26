import type { Metadata } from "next"

import { Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { deliveryMetrics, type DeliveryMetrics } from "@/lib/delivery/metrics"
import { formatInr } from "@/lib/money"

export const metadata: Metadata = { title: "Delivery" }

// Delivery metrics (track N, N2, ND-17; EVALUATION_PLAN §1): NM1–NM10 for 7
// and 30 days across everyone, as counts and rates. Every rate shows "x of
// n" and "no data" when n is 0; a missing price is "not priced", never ₹0.
// Nothing a person wrote or an app returned appears here (AT-OWN-A1).
// Read-only; switches are edited in Config.

const of = (x: number, n: number) => (n === 0 ? "no data" : `${x} of ${n}`)
const pct = (x: number, n: number) => (n === 0 ? "—" : `${Math.round((x / n) * 100)} %`)

function Window({ m }: { m: DeliveryMetrics }) {
  const { nm6 } = m
  return (
    <Tiles>
      <Tile
        label="NM1 delivered"
        value={of(m.nm1.delivered, m.nm1.n)}
        hint={`${pct(m.nm1.delivered, m.nm1.n)} · tasks with something to deliver`}
      />
      <Tile
        label="NM2 partly delivered"
        value={of(m.nm2.partly, m.nm2.n)}
        hint={pct(m.nm2.partly, m.nm2.n)}
      />
      <Tile
        label="NM3 not confirmed"
        value={of(m.nm3.notConfirmed, m.nm3.n)}
        hint={`${pct(m.nm3.notConfirmed, m.nm3.n)} · watch for a rise`}
      />
      <Tile
        label="NM4 checked later"
        value={of(m.nm4.verified, m.nm4.n)}
        hint="re-checked runs a check verified"
      />
      <Tile
        label="NM5 unbacked claims"
        value={of(m.nm5.unbacked, m.nm5.n)}
        hint="of records, no tool run behind them"
      />
      <Tile
        label="NM6 ₹ per delivered task"
        value={
          nm6.perTaskMicroInr === null
            ? nm6.delivered === 0
              ? "no data"
              : "not priced"
            : formatInr(nm6.perTaskMicroInr)
        }
        hint={
          nm6.priced
            ? `${nm6.priced} priced · ${nm6.unpriced} not priced · final ${formatInr(nm6.finalMicroInr)} · estimated ${formatInr(nm6.estimatedMicroInr)}`
            : `${nm6.unpriced} not priced`
        }
      />
      <Tile
        label="NM7 app definitions"
        value="in the log"
        hint="per task, as characters: worker log “tool definitions”"
      />
      <Tile
        label="NM8 unapproved app actions"
        value={m.nm8.unapproved}
        tone={m.nm8.unapproved > 0 ? "bad" : "good"}
        hint="target 0 · records only, see logs for the rest"
      />
      <Tile
        label="NM10 wasted steps"
        value={of(m.nm10.wasted, m.nm10.n)}
        hint={`${pct(m.nm10.wasted, m.nm10.n)} · steps whose tool calls all failed on a busy app`}
      />
      <Tile
        label="C1 input tokens per task"
        value={m.c1.tasks === 0 ? "no data" : Math.round(m.c1.inputTokens / m.c1.tasks)}
        hint={`${m.c1.inputTokens} tokens over ${m.c1.tasks} tasks · reported usage only`}
      />
      <Tile
        label="C3 served from cache"
        value={pct(m.c3.cachedTokens, m.c3.inputTokens)}
        hint={`${m.c3.cachedTokens} of ${m.c3.inputTokens} input tokens`}
      />
    </Tiles>
  )
}

export default async function OwnerDelivery() {
  await requireOwner()
  const [week, month, delivery, inbox] = await Promise.all([
    deliveryMetrics(7),
    deliveryMetrics(30),
    getSetting("next.delivery"),
    getSetting("agents.inbox"),
  ])

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Delivery
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Whether tasks got done, across everyone, as counts. The delivery line on
          &ldquo;What I did&rdquo; is {delivery === "on" ? "on" : "off"}; it needs the
          Inbox, which is {inbox === "on" ? "on" : "off"}. These figures read the same
          records either way. Change switches in Config.
        </p>
      </header>

      <Section title="Last 7 days">
        <Window m={week} />
      </Section>
      <Section title="Last 30 days">
        <Window m={month} />
      </Section>

      <Section
        title="Tasks by delivery status"
        description="Last 30 days, tasks that have a &ldquo;What I did&rdquo; record."
      >
        <Table head={["status", "tasks"]}>
          {Object.values(month.statuses).every((n) => n === 0) && (
            <Empty colSpan={2}>No records yet.</Empty>
          )}
          {Object.entries(month.statuses)
            .filter(([, n]) => n > 0)
            .map(([status, n]) => (
              <tr key={status}>
                <Td className="font-mono text-[12px]">{status}</Td>
                <Td className="tabular-nums">{n}</Td>
              </tr>
            ))}
        </Table>
      </Section>

      <Section
        title="Apps: calls that failed"
        description="NM9, last 30 days, by app. More than a fifth failing for a day is worth a look."
      >
        <Table head={["app", "failed", "calls"]}>
          {month.nm9.length === 0 && <Empty colSpan={3}>No app calls yet.</Empty>}
          {month.nm9.map((row) => (
            <tr key={row.server}>
              <Td className="font-mono text-[12px]">{row.server}</Td>
              <Td className="tabular-nums">{row.failed}</Td>
              <Td className="tabular-nums">{row.n}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  )
}
