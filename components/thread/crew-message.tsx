"use client"

import Link from "next/link"
import { ChevronRightIcon } from "lucide-react"

import { Markdown } from "@/components/thread/markdown"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

// U3: crew messages (O11) are written for the model by lib/operator/crews.ts
// (briefFor, joinText). The person sees the parts that matter; the exact text
// stays one tap away. Unrecognised text returns null and renders as before.

export type CrewReport = {
  round: number | null
  members: {
    name: string
    status: string
    result: string
    href: string | null
  }[]
}

const HEADER = /^## (.+) · (.+) · (.+)$/
const LINK = /^What they did: (\/a\/[^/\s]+\/\S+)$/

export function parseCrewResults(text: string): CrewReport | null {
  const members: CrewReport["members"] = []
  let current: { name: string; status: string; lines: string[] } | null = null
  const close = (href: string | null) => {
    if (!current) return
    members.push({
      name: current.name,
      status: current.status.replace("the person's", "your"),
      result: current.lines.join("\n").trim(),
      href,
    })
    current = null
  }
  for (const line of text.split("\n")) {
    const header = HEADER.exec(line)
    const link = LINK.exec(line)
    if (header) {
      close(null)
      current = { name: header[1], status: header[3], lines: [] }
    } else if (link && current) close(link[1])
    else current?.lines.push(line)
  }
  // The closing instruction to the lead follows the last link, outside any member
  if (!members.length) return null
  const round = /results are in \(round (\d+)\)/.exec(text)
  return { round: round ? Number(round[1]) : null, members }
}

const BRIEF =
  /^Your part of the job "(.*)", from (.+?):\n([\s\S]*?)\n\nDo it yourself with your own tools\./

export function parseCrewBrief(text: string) {
  const match = BRIEF.exec(text)
  return match ? { job: match[1], lead: match[2], brief: match[3].trim() } : null
}

function SentText({ text }: { text: string }) {
  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger className="group/sent flex min-h-11 w-full items-center gap-1.5 px-4 text-left text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-4 transition-transform group-data-[panel-open]/sent:rotate-90" />
        What the agent was sent
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  )
}

const shell =
  "w-full overflow-hidden rounded-2xl border bg-card text-left text-foreground"

export function CrewReportCard({ report, text }: { report: CrewReport; text: string }) {
  return (
    <div className={shell}>
      <div className="px-4 pt-3 pb-1 text-sm font-semibold">
        Team report{report.round && report.round > 1 ? ` · round ${report.round}` : ""}
      </div>
      <ul className="divide-y">
        {report.members.map((member, i) => (
          <li key={i} className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{member.name}</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs",
                  member.status === "Done"
                    ? "bg-rigel-soft text-rigel"
                    : member.status === "Failed"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {member.status}
              </span>
            </div>
            <Markdown className="text-sm">{member.result}</Markdown>
            {member.href && (
              <Link
                href={member.href}
                className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-rigel hover:underline"
              >
                Open {member.name}&apos;s thread <ChevronRightIcon className="size-4" />
              </Link>
            )}
          </li>
        ))}
      </ul>
      <SentText text={text} />
    </div>
  )
}

export function CrewBriefCard({
  brief,
  text,
}: {
  brief: NonNullable<ReturnType<typeof parseCrewBrief>>
  text: string
}) {
  return (
    <div className={shell}>
      <div className="flex flex-col gap-1 px-4 py-3">
        <span className="text-xs text-muted-foreground">
          From {brief.lead} · {brief.job}
        </span>
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{brief.brief}</p>
      </div>
      <SentText text={text} />
    </div>
  )
}
