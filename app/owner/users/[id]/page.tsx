import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { UserStatusForm } from "@/components/owner/forms"
import { Empty, Section, Table, Td, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { formatInr, formatPaise, formatUsd } from "@/lib/money"
import { userDetail } from "@/lib/owner"

export const metadata: Metadata = { title: "User" }

const when = (value: string | Date | null) =>
  value
    ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "—"
const day = (value: string | Date | null) =>
  value ? new Date(value).toLocaleDateString("en-IN") : "—"

// Account metadata, billing and task outcomes. Deliberately no messages,
// memories or agent instructions: those belong to the person.
export default async function OwnerUser({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner()
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id)
  if (!id.success) notFound()
  const user = await userDetail(id.data)
  if (!user) notFound()
  const status = user.profile?.status ?? "active"
  const charged = user.recentTasks.reduce((sum, task) => sum + (task.charge ?? 0), 0)

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[28px] leading-tight font-normal break-all sm:text-[34px]">
          {user.account.email ?? user.account.id}
        </h1>
        <p className="font-mono text-[11.5px] text-muted-foreground">{user.account.id}</p>
      </header>

      <Tiles>
        <Tile label="plan" value={user.planId} />
        <Tile
          label="status"
          value={status}
          tone={status === "suspended" ? "bad" : "good"}
        />
        <Tile label="joined" value={day(user.account.created_at)} />
        <Tile label="last sign-in" value={day(user.account.last_sign_in_at)} />
      </Tiles>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Profile">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{user.profile?.displayName ?? "—"}</dd>
            <dt className="text-muted-foreground">Use</dt>
            <dd>{user.profile?.useCase ?? "—"}</dd>
            <dt className="text-muted-foreground">Language</dt>
            <dd>{user.profile?.locale ?? "—"}</dd>
            <dt className="text-muted-foreground">Email verified</dt>
            <dd>{when(user.account.email_confirmed_at)}</dd>
            {user.profile?.suspendedReason && (
              <>
                <dt className="text-muted-foreground">Suspended for</dt>
                <dd>{user.profile.suspendedReason}</dd>
              </>
            )}
          </dl>
        </Section>
        <Section
          title="Access"
          description="Suspending stops running tasks and blocks the app until reactivated."
        >
          <UserStatusForm userId={user.account.id} status={status} />
        </Section>
      </div>

      <Section title="Subscriptions">
        <Table head={["plan", "status", "provider", "period end", "created"]}>
          {user.subs.length === 0 && (
            <Empty colSpan={5}>Free plan, no subscription.</Empty>
          )}
          {user.subs.map((sub) => (
            <tr key={sub.id}>
              <Td className="font-mono">{sub.planId}</Td>
              <Td>
                {sub.status}
                {sub.cancelAtPeriodEnd && " · cancels at end"}
              </Td>
              <Td className="font-mono text-[11.5px]">
                {sub.provider} · {sub.providerSubscriptionId}
              </Td>
              <Td>{when(sub.currentPeriodEnd)}</Td>
              <Td>{when(sub.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Payments">
        <Table head={["amount", "status", "provider id", "paid"]}>
          {user.payments.length === 0 && <Empty colSpan={4}>No payments.</Empty>}
          {user.payments.map((payment) => (
            <tr key={payment.id}>
              <Td className="font-mono tabular-nums">
                {formatPaise(payment.amountPaise)}
              </Td>
              <Td>{payment.status}</Td>
              <Td className="font-mono text-[11.5px]">{payment.providerPaymentId}</Td>
              <Td>{when(payment.paidAt)}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Recent tasks"
        description={`${formatInr(charged)} charged across these.`}
      >
        <Table
          head={[
            "status",
            "tier",
            "model",
            "attempts",
            "provider cost",
            "charged",
            "created",
          ]}
        >
          {user.recentTasks.length === 0 && <Empty colSpan={7}>No tasks yet.</Empty>}
          {user.recentTasks.map((task) => (
            <tr key={task.id}>
              <Td>
                {task.status}
                {task.errorCode && (
                  <span className="text-destructive"> · {task.errorCode}</span>
                )}
              </Td>
              <Td>{task.tier}</Td>
              <Td className="font-mono text-[11.5px]">{task.model ?? "—"}</Td>
              <Td className="font-mono tabular-nums">{task.attempts}</Td>
              <Td className="font-mono tabular-nums">{formatUsd(task.cost)}</Td>
              <Td className="font-mono tabular-nums">{formatInr(task.charge)}</Td>
              <Td className="text-muted-foreground">{when(task.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Owner actions on this account">
        <Table head={["action", "details", "when"]}>
          {user.auditTrail.length === 0 && <Empty colSpan={3}>None.</Empty>}
          {user.auditTrail.map((event) => (
            <tr key={event.id}>
              <Td className="font-mono">{event.action}</Td>
              <Td className="font-mono text-[11.5px] break-all">
                {event.details ? JSON.stringify(event.details) : "—"}
              </Td>
              <Td>{when(event.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  )
}
