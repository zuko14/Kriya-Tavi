import type { Metadata } from "next"
import Link from "next/link"
import { formatDistanceToNowStrict } from "date-fns"

import { ReportReview } from "@/components/rooms/report-review"
import { Section, Tile, Tiles } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { roomLimit } from "@/lib/rooms/core"
import { roomsOverview } from "@/queries/rooms"

export const metadata: Metadata = { title: "Rooms" }

// Rooms (track R, R9, RC-5): reports people sent, each with the copy the
// database made of the reported message, and the numbers to watch for
// scale (ARCHITECTURE §5, REALTIME §4). People by id, as other owner pages;
// a person's account (suspend) is under Members. Room contents are shown
// only where someone reported them.

const REASON = {
  spam: "Spam or scam",
  harassment: "Harassment or abuse",
  unsafe: "Dangerous or illegal",
  private_info: "Private information",
  other: "Something else",
} as const

const id8 = (id: string | null) => (id ? id.slice(0, 8) : "—")

export default async function OwnerRooms() {
  await requireOwner()
  const [overview, maxHumans] = await Promise.all([
    roomsOverview(),
    roomLimit("rooms.maxHumans"),
  ])
  const open = overview.reports.filter((r) => r.status === "open")
  const closed = overview.reports.filter((r) => r.status !== "open")

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Rooms
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Reports from people in rooms, and how busy rooms are. Switches are in Config.
        </p>
      </header>

      <Tiles>
        <Tile
          label="open reports"
          value={String(overview.openReports)}
          tone={overview.openReports > 0 ? "warn" : undefined}
        />
        <Tile label="active rooms" value={overview.activeRooms.toLocaleString("en-IN")} />
        <Tile
          label="messages, 24 h"
          value={overview.messagesDay.toLocaleString("en-IN")}
          hint={`busiest room ${overview.busiestDay.toLocaleString("en-IN")}`}
        />
        <Tile
          label="largest room"
          value={`${overview.largestRoom} / ${maxHumans}`}
          hint={`people; ${overview.blocks} ${overview.blocks === 1 ? "block" : "blocks"} in all`}
        />
      </Tiles>

      <Section
        title="Open reports"
        description="Reviewed closes a report you acted on (for example by suspending the person under Members); Dismiss closes one that needs nothing."
      >
        {open.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No open reports.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {open.map((report) => (
              <li key={report.id} className="glass flex flex-col gap-2 rounded-2xl p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium">{REASON[report.reason]}</span>
                  <span className="font-mono text-[11px] text-faint">
                    {formatDistanceToNowStrict(report.createdAt, { addSuffix: true })}
                  </span>
                </div>
                <p className="text-[12.5px] text-muted-foreground">
                  {report.messageId || report.authorKind ? "A message in" : "The room"} “
                  {report.roomTitle}”{report.roomStatus === "archived" && " (archived)"} ·
                  reported by <span className="font-mono">{id8(report.reporterId)}</span>
                </p>
                {report.authorKind && (
                  <blockquote className="flex flex-col gap-1 rounded-xl border px-3 py-2">
                    <span className="text-[11.5px] text-muted-foreground">
                      {report.authorKind === "agent"
                        ? `Agent ${report.agentId} of `
                        : report.authorKind === "system"
                          ? "Kriya"
                          : "Person "}
                      {report.authorKind !== "system" && report.authorId && (
                        <Link
                          href={`/owner/users/${report.authorId}`}
                          className="font-mono underline underline-offset-2"
                        >
                          {id8(report.authorId)}
                        </Link>
                      )}
                    </span>
                    <span className="text-[13.5px] break-words whitespace-pre-wrap">
                      {report.body ?? (
                        <em className="text-muted-foreground">
                          Deleted before the report
                        </em>
                      )}
                    </span>
                  </blockquote>
                )}
                {report.note && (
                  <p className="text-[13px] break-words">
                    <span className="label-mono mr-1.5">note</span>
                    {report.note}
                  </p>
                )}
                <ReportReview
                  reportId={report.id}
                  active={report.roomStatus === "active"}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {closed.length > 0 && (
        <Section title="Closed" description="The latest reports already answered.">
          <ul className="flex flex-col divide-y rounded-xl border">
            {closed.map((report) => (
              <li
                key={report.id}
                className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]"
              >
                <span className="font-medium">{REASON[report.reason]}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  “{report.roomTitle}”
                </span>
                <span className="text-muted-foreground">{report.status}</span>
                {report.reviewedAt && (
                  <span className="font-mono text-[11px] text-faint">
                    {formatDistanceToNowStrict(report.reviewedAt, { addSuffix: true })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}
