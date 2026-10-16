"use client"

import * as React from "react"
import {
  BrainIcon,
  CalendarIcon,
  CalendarPlusIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CornerDownRightIcon,
  EraserIcon,
  FileTextIcon,
  GlobeIcon,
  MailIcon,
  MailPlusIcon,
  NotebookTextIcon,
  SearchIcon,
  SplitIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { KriyaMessage } from "@/lib/agent/tools"
import { cn } from "@/lib/utils"

export type ToolPart = Extract<KriyaMessage["parts"][number], { type: `tool-${string}` }>

type Meta = {
  icon: LucideIcon
  label: string
  summary?: (input: Record<string, unknown>) => string
}

const str = (value: unknown) => (typeof value === "string" ? value : "")

const META: Record<string, Meta> = {
  web_search: { icon: SearchIcon, label: "search", summary: (i) => str(i.query) },
  web_fetch: {
    icon: GlobeIcon,
    label: "read",
    summary: (i) => str(i.url).replace(/^https?:\/\/(www\.)?/, ""),
  },
  memory_write: { icon: BrainIcon, label: "remember", summary: (i) => str(i.note) },
  memory_forget: { icon: EraserIcon, label: "forget", summary: (i) => str(i.id) },
  assign: { icon: SplitIcon, label: "split the work" },
  calendar_events: {
    icon: CalendarIcon,
    label: "calendar",
    summary: (i) => str(i.query) || "upcoming events",
  },
  calendar_create_event: {
    icon: CalendarPlusIcon,
    label: "add event",
    summary: (i) => str(i.title),
  },
  gmail_search: { icon: MailIcon, label: "gmail", summary: (i) => str(i.query) },
  gmail_read: { icon: MailIcon, label: "read email" },
  gmail_draft: {
    icon: MailPlusIcon,
    label: "draft email",
    summary: (i) => str(i.subject),
  },
  drive_search: { icon: FileTextIcon, label: "drive", summary: (i) => str(i.query) },
  drive_read: { icon: FileTextIcon, label: "read file" },
  notion_search: {
    icon: NotebookTextIcon,
    label: "notion",
    summary: (i) => str(i.query),
  },
  notion_read: { icon: NotebookTextIcon, label: "read page" },
  delegate: {
    icon: CornerDownRightIcon,
    label: "delegate",
    summary: (i) => str(i.brief),
  },
}

export function toolName(part: ToolPart) {
  return part.type.slice("tool-".length)
}

function Pre({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-md border bg-background/70 px-3 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90",
        className
      )}
    >
      {children}
    </pre>
  )
}

// Links only to the web: a source can't smuggle in a javascript: URL
function safeHref(url: string) {
  return /^https?:\/\//i.test(url) ? url : undefined
}

// What the tool returned: the evidence behind the agent's answer
function Details({ part }: { part: ToolPart }) {
  const name = toolName(part)
  const input = (part.input ?? {}) as Record<string, unknown>
  const output =
    part.state === "output-available" ? (part.output as Record<string, unknown>) : null

  if (part.state === "output-error") {
    return (
      <div className="flex flex-col gap-2">
        {Object.keys(input).length > 0 && <Pre>{JSON.stringify(input, null, 2)}</Pre>}
        <Pre className="border-destructive/30 bg-destructive/5 text-destructive">
          {part.errorText}
        </Pre>
      </div>
    )
  }

  switch (name) {
    case "web_search":
      return output ? (
        <ol className="flex flex-col gap-2">
          {(
            (output.results ?? []) as { title: string; url: string; snippet: string }[]
          ).map((result) => (
            <li key={result.url} className="flex min-w-0 flex-col gap-0.5">
              <a
                href={safeHref(result.url)}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[13px] font-medium text-rigel hover:underline"
              >
                {result.title}
              </a>
              <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                {result.url}
              </span>
              {result.snippet && (
                <span className="line-clamp-2 text-[12px] text-muted-foreground">
                  {result.snippet}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : null
    case "web_fetch":
      return output ? (
        <div className="flex flex-col gap-2">
          <a
            href={safeHref(str(output.url))}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[13px] font-medium break-all text-rigel hover:underline"
          >
            {str(output.title) || str(output.url)}
          </a>
          <Pre>{str(output.markdown).slice(0, 4000)}</Pre>
        </div>
      ) : null
    case "memory_write":
      return <p className="text-[13px]">{str(input.note)}</p>
    default:
      return (
        <div className="flex flex-col gap-2">
          <Pre>{JSON.stringify(input, null, 2)}</Pre>
          {output && <Pre>{JSON.stringify(output, null, 2)}</Pre>}
        </div>
      )
  }
}

// Answers a tool call waiting for approval; provided by the thread view
export const ApprovalContext = React.createContext<
  ((approvalId: string, approved: boolean) => Promise<void>) | null
>(null)

const list = (value: unknown) =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : ""

function when(start: string, end: string, timeZone: string) {
  const format = (value: string, withDate: boolean) => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString("en-IN", {
      ...(withDate && { weekday: "short", day: "numeric", month: "short" }),
      hour: "numeric",
      minute: "2-digit",
    })
  }
  return `${format(start, true)} – ${format(end, false)}${timeZone ? ` (${timeZone})` : ""}`
}

// What the agent wants to do, in full, with Approve and Decline. Nothing
// happens outside Kriya until the person approves.
function ApprovalCard({ part }: { part: ToolPart }) {
  const respond = React.useContext(ApprovalContext)
  const [answer, setAnswer] = React.useState<boolean | null>(null)
  const name = toolName(part)
  const input = (part.input ?? {}) as Record<string, unknown>
  const approvalId = (part as { approval?: { id?: string } }).approval?.id

  const rows: [string, string][] =
    name === "calendar_create_event"
      ? [
          ["Event", str(input.title)],
          ["When", when(str(input.start), str(input.end), str(input.timeZone))],
          ["Where", str(input.location)],
          ["Guests", list(input.attendees)],
          ["Notes", str(input.description)],
        ]
      : name === "gmail_draft"
        ? [
            ["To", list(input.to)],
            ["Cc", list(input.cc)],
            ["Subject", str(input.subject)],
          ]
        : name === "web_fetch"
          ? [["Page", str(input.url)]]
          : name === "web_search"
            ? [["Search", str(input.query)]]
            : [["Details", JSON.stringify(input)]]
  const note =
    name === "calendar_create_event"
      ? list(input.attendees)
        ? "Added to your Google Calendar. Google emails an invite to each guest."
        : "Added to your Google Calendar. No one else is notified."
      : name === "gmail_draft"
        ? "Saved as a draft in your Gmail. Nothing is sent: you send it yourself."
        : name === "web_fetch" || name === "web_search"
          ? "Your private mail or documents are in this conversation, so web requests need your ok. Check that the address or search doesn't carry anything private."
          : "This changes something outside Kriya."

  const decide = async (approved: boolean) => {
    if (!respond || !approvalId) return
    setAnswer(approved)
    try {
      await respond(approvalId, approved)
    } catch {
      setAnswer(null)
    }
  }

  return (
    <div
      role="group"
      aria-label="Waiting for your approval"
      className="mx-2 my-1 flex flex-col gap-3 rounded-2xl border border-betelgeuse/40 bg-betelgeuse-soft p-3.5"
    >
      <span className="label-mono text-betelgeuse">needs your ok</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </React.Fragment>
          ))}
      </dl>
      {name === "gmail_draft" && str(input.body) && (
        <Pre className="max-h-48">{str(input.body)}</Pre>
      )}
      <p className="text-[12px] text-muted-foreground">{note}</p>
      <div className="flex gap-2">
        <Button
          className="h-11 flex-1 sm:h-9 sm:flex-none"
          disabled={answer !== null || !respond}
          onClick={() => decide(true)}
        >
          {answer === true && <Spinner data-icon="inline-start" />}
          Approve
        </Button>
        <Button
          variant="outline"
          className="h-11 flex-1 sm:h-9 sm:flex-none"
          disabled={answer !== null || !respond}
          onClick={() => decide(false)}
        >
          {answer === false && <Spinner data-icon="inline-start" />}
          Decline
        </Button>
      </div>
    </div>
  )
}

export function ToolCall({
  part,
  live = true,
}: {
  part: ToolPart
  live?: boolean
  awaiting?: boolean
}) {
  const name = toolName(part)
  const meta = META[name] ?? { icon: WrenchIcon, label: name }
  const Icon = meta.icon
  if (part.state === "approval-requested") return <ApprovalCard part={part} />
  const declined =
    part.state === "output-denied" ||
    (part.state === "approval-responded" && part.approval.approved === false)
  const pending =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "approval-responded" && !declined)
  // A call still pending after its task ended was cut off by a stop or a failure
  const running = pending && live
  const interrupted = pending && !live
  const failed = part.state === "output-error"
  const summary = meta.summary?.((part.input ?? {}) as Record<string, unknown>) ?? ""

  return (
    <Collapsible className="group/tool">
      <CollapsibleTrigger
        className={cn(
          "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left font-mono text-[12px] transition-colors hover:border-border hover:bg-accent/40",
          "data-panel-open:border-border data-panel-open:bg-accent/30"
        )}
      >
        <span className="grid size-4 shrink-0 place-items-center">
          {running ? (
            <Spinner className="size-3 text-rigel" />
          ) : interrupted ? (
            <CircleSlashIcon className="size-3.5 text-faint" aria-label="interrupted" />
          ) : declined ? (
            <CircleSlashIcon className="size-3.5 text-faint" aria-label="declined" />
          ) : failed ? (
            <XIcon className="size-3.5 text-destructive" aria-label="failed" />
          ) : (
            <CheckIcon className="size-3.5 text-ok" aria-label="done" />
          )}
        </span>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("shrink-0", running && "shimmer-text")}>{meta.label}</span>
        <span className="min-w-0 truncate text-muted-foreground">{summary}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-faint">
          {declined ? "declined" : interrupted && "interrupted"}
          <ChevronRightIcon className="size-3.5 transition-transform group-data-open/tool:rotate-90" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5 pb-1 pl-8">
        <Details part={part} />
      </CollapsibleContent>
    </Collapsible>
  )
}
