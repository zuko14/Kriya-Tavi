import type { Metadata } from "next"

import { Empty, Section, Table, Td } from "@/components/owner/ui"
import { Input } from "@/components/ui/input"
import { requireOwner } from "@/lib/auth"
import { auditLog } from "@/lib/owner"

export const metadata: Metadata = { title: "Audit" }

export default async function OwnerAudit({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>
}) {
  await requireOwner()
  const { action = "" } = await searchParams
  const events = await auditLog(action.slice(0, 60) || undefined)

  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Audit log
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Every privileged action, newest first. Entries can&apos;t be edited or deleted
          from the app.
        </p>
        <form className="max-w-sm" role="search">
          <Input
            name="action"
            defaultValue={action}
            placeholder="Filter by action, e.g. user.suspend"
            aria-label="Filter by action"
            className="h-9"
          />
        </form>
      </header>
      <Section title={`${events.length} event(s)`}>
        <Table head={["when", "actor", "action", "target", "details"]}>
          {events.length === 0 && <Empty colSpan={5}>No events.</Empty>}
          {events.map((event) => (
            <tr key={event.id}>
              <Td className="text-[11.5px] whitespace-nowrap text-muted-foreground">
                {event.createdAt.toLocaleString("en-IN", {
                  dateStyle: "short",
                  timeStyle: "medium",
                })}
              </Td>
              <Td className="text-[12px]">{event.actor ?? "—"}</Td>
              <Td className="font-mono text-[11.5px]">{event.action}</Td>
              <Td className="font-mono text-[11px]">
                {event.targetType ? `${event.targetType}:${event.targetId}` : "—"}
              </Td>
              <Td className="max-w-96 font-mono text-[11px] break-all text-muted-foreground">
                {event.details ? JSON.stringify(event.details) : "—"}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  )
}
