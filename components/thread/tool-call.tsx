"use client"

import * as React from "react"
import {
  BrainIcon,
  BriefcaseIcon,
  CameraIcon,
  CalendarClockIcon,
  CalendarIcon,
  CalendarPlusIcon,
  CalendarXIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  CircleSlashIcon,
  CodeXmlIcon,
  CornerDownRightIcon,
  EraserIcon,
  FileDiffIcon,
  FilePenIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitPullRequestDraftIcon,
  GlobeIcon,
  ListChecksIcon,
  MailIcon,
  MailPlusIcon,
  MessagesSquareIcon,
  NotebookTextIcon,
  PhoneIcon,
  PlayIcon,
  SearchIcon,
  SendIcon,
  Share2Icon,
  SheetIcon,
  SplitIcon,
  TargetIcon,
  TerminalIcon,
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
import { ThreadCallWatch } from "@/components/voice/thread-call-watch"
import type { KriyaMessage } from "@/lib/agent/tools"
import { cn } from "@/lib/utils"

export type ToolPart = Extract<KriyaMessage["parts"][number], { type: `tool-${string}` }>

type Meta = {
  icon: LucideIcon
  label: string
  summary?: (input: Record<string, unknown>) => string
  // What came back, after the summary (track C's workspace cards)
  outcome?: (output: Record<string, unknown>) => string
}

const str = (value: unknown) => (typeof value === "string" ? value : "")

const META: Record<string, Meta> = {
  web_search: { icon: SearchIcon, label: "search", summary: (i) => str(i.query) },
  web_fetch: {
    icon: GlobeIcon,
    label: "read",
    summary: (i) => str(i.url).replace(/^https?:\/\/(www\.)?/, ""),
  },
  browser_open: {
    icon: GlobeIcon,
    label: "browse",
    summary: (i) => str(i.url).replace(/^https?:\/\/(www\.)?/, ""),
  },
  browser_snapshot: { icon: GlobeIcon, label: "look at the page" },
  browser_click: { icon: GlobeIcon, label: "click", summary: (i) => str(i.ref) },
  browser_scroll: { icon: GlobeIcon, label: "scroll", summary: (i) => str(i.direction) },
  browser_handoff: { icon: GlobeIcon, label: "over to you", summary: (i) => str(i.note) },
  browser_close: { icon: GlobeIcon, label: "close the browser" },
  memory_write: { icon: BrainIcon, label: "remember", summary: (i) => str(i.note) },
  memory_forget: { icon: EraserIcon, label: "forget", summary: (i) => str(i.id) },
  memory_update: { icon: BrainIcon, label: "update memory", summary: (i) => str(i.note) },
  memory_search: {
    icon: SearchIcon,
    label: "search memory",
    summary: (i) => str(i.query),
  },
  assign: { icon: SplitIcon, label: "split the work" },
  goal_create: { icon: TargetIcon, label: "start a goal", summary: (i) => str(i.title) },
  goal_update: { icon: ListChecksIcon, label: "update a goal" },
  schedule_create: {
    icon: CalendarClockIcon,
    label: "schedule",
    summary: (i) => str(i.prompt),
  },
  schedule_update: {
    icon: CalendarClockIcon,
    label: "change a schedule",
    summary: (i) => str(i.status),
  },
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
  // A8 connectors
  github_search: { icon: GitBranchIcon, label: "github", summary: (i) => str(i.query) },
  github_read_issue: { icon: GitBranchIcon, label: "read issue", summary: (i) => ref(i) },
  github_read_pr: {
    icon: GitBranchIcon,
    label: "read pull request",
    summary: (i) => ref(i),
  },
  github_comment: { icon: GitBranchIcon, label: "comment", summary: (i) => ref(i) },
  github_create_issue: {
    icon: GitBranchIcon,
    label: "open issue",
    summary: (i) => str(i.title),
  },
  github_label: { icon: GitBranchIcon, label: "label", summary: (i) => ref(i) },
  github_open_pr: {
    icon: GitBranchIcon,
    label: "open pull request",
    summary: (i) => str(i.title),
  },
  sheets_read: { icon: SheetIcon, label: "read sheet", summary: (i) => str(i.range) },
  sheets_append: { icon: SheetIcon, label: "add rows", summary: (i) => str(i.range) },
  sheets_update: { icon: SheetIcon, label: "update cells", summary: (i) => str(i.range) },
  sheets_create: { icon: SheetIcon, label: "new sheet", summary: (i) => str(i.title) },
  sheets_total: { icon: SheetIcon, label: "add up", summary: (i) => str(i.amount) },
  youtube_stats: { icon: PlayIcon, label: "youtube stats" },
  instagram_insights: { icon: CameraIcon, label: "instagram stats" },
  // A9 skills
  skill_propose: {
    icon: ListChecksIcon,
    label: "save as skill",
    summary: (i) => str(i.name),
  },
  skill_list: { icon: ListChecksIcon, label: "skills" },
  skill_run: { icon: ListChecksIcon, label: "run skill", summary: (i) => str(i.skillId) },
  ledger_list: { icon: ListChecksIcon, label: "accounts" },
  ledger_draft_entry: { icon: ListChecksIcon, label: "draft entries" },
  invoice_draft: {
    icon: ListChecksIcon,
    label: "draft invoice",
    summary: (i) => str((i.client as { name?: string } | undefined)?.name),
  },
  facts_lookup: {
    icon: ListChecksIcon,
    label: "official facts",
    summary: (i) => str(i.key ?? i.query),
  },
  obligation_add: {
    icon: ListChecksIcon,
    label: "add to Radar",
    summary: (i) => str(i.title),
  },
  obligation_list: { icon: ListChecksIcon, label: "Radar" },
  kit_prepare: {
    icon: ClipboardListIcon,
    label: "ready-to-apply kit",
    summary: (i) => str(i.title),
  },
  kit_check: { icon: ClipboardListIcon, label: "check applied kit" },
  instagram_publish: {
    icon: CameraIcon,
    label: "post on instagram",
    summary: (i) => str(i.caption),
  },
  file_read: { icon: FileTextIcon, label: "read a file" },
  file_list: { icon: FileTextIcon, label: "list files", summary: (i) => str(i.query) },
  file_save_attachment: { icon: FileTextIcon, label: "save an attachment" },
  document_render: {
    icon: FileTextIcon,
    label: "make a pdf",
    summary: (i) => str(i.name),
  },
  // G2
  drive_import: { icon: FileTextIcon, label: "copy from drive" },
  drive_share: {
    icon: Share2Icon,
    label: "share a drive file",
    summary: (i) => list(i.emails),
  },
  gmail_send_draft: { icon: SendIcon, label: "send a draft" },
  calendar_delete_event: {
    icon: CalendarXIcon,
    label: "delete event",
    summary: (i) => str(i.title),
  },
  propose_call: {
    icon: PhoneIcon,
    label: "draft a call",
    summary: (i) => str(i.recipientLabel),
  },
  // Track O: a job proposal the person approves in the Inbox
  mandate_propose: {
    icon: BriefcaseIcon,
    label: "propose a job",
    summary: (i) => str(i.title),
  },
  mandate_status: { icon: ListChecksIcon, label: "job status" },
  mandate_report: { icon: ListChecksIcon, label: "check the job against records" },
  // O11: members who act, each in their own thread
  crew_dispatch: {
    icon: BriefcaseIcon,
    label: "hand parts to the crew",
    summary: (i) => (Array.isArray(i.parts) ? `${i.parts.length} parts` : ""),
  },
  // Track C: the thread's cloud workspace (UX_SPEC §3)
  workspace_open: {
    icon: CodeXmlIcon,
    label: "open workspace",
    summary: (i) => str(i.repo) || "blank project",
    outcome: (o) =>
      o.restored
        ? "restored from the last save"
        : str(o.ref) && str(o.baseSha)
          ? `at ${str(o.ref)} (${str(o.baseSha).slice(0, 7)})`
          : "",
  },
  workspace_run: {
    icon: TerminalIcon,
    label: "run",
    summary: (i) => `$ ${str(i.command)}`,
    outcome: (o) => runOutcome(o),
  },
  workspace_read: {
    icon: FileTextIcon,
    label: "read",
    summary: (i) =>
      `${str(i.path)}${i.startLine ? ` (lines ${i.startLine}–${i.endLine ?? "…"})` : ""}`,
  },
  workspace_list: {
    icon: FolderTreeIcon,
    label: "list files",
    summary: (i) => str(i.path),
  },
  workspace_search: {
    icon: FileSearchIcon,
    label: "search files",
    summary: (i) => str(i.pattern),
    outcome: (o) =>
      Array.isArray(o.matches)
        ? `${o.matches.length}${o.truncated ? "+" : ""} ${o.matches.length === 1 ? "match" : "matches"}`
        : "",
  },
  workspace_write: { icon: FilePenIcon, label: "write", summary: (i) => str(i.path) },
  workspace_edit: { icon: FilePenIcon, label: "edit", summary: (i) => str(i.path) },
  workspace_patch: {
    icon: FileDiffIcon,
    label: "patch",
    outcome: (o) => (Array.isArray(o.files) ? filesChanged(o.files.length) : ""),
  },
  workspace_changes: {
    icon: FileDiffIcon,
    label: "changes",
    outcome: (o) => {
      if (!Array.isArray(o.files)) return ""
      const files = o.files as { added?: number; removed?: number }[]
      const added = files.reduce((n, f) => n + (f.added ?? 0), 0)
      const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0)
      return `${filesChanged(files.length)}, +${added} −${removed}`
    },
  },
  workspace_publish: {
    icon: GitPullRequestDraftIcon,
    label: "draft pull request",
    summary: (i) => str(i.title),
  },
  // Track R: a note for the room, unconfirmed until a member confirms it
  room_note_add: {
    icon: NotebookTextIcon,
    label: "note for the room",
    summary: (i) => str(i.note),
    outcome: (o) =>
      o.saved === true ? "waiting for a member to confirm" : str(o.message),
  },
  // Track R: a room request reading more of its room
  room_history: {
    icon: MessagesSquareIcon,
    label: "read the room",
    outcome: (o) =>
      Array.isArray(o.messages)
        ? `${o.messages.length} ${o.messages.length === 1 ? "message" : "messages"}`
        : "",
  },
}

const filesChanged = (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`

// "✓ exit 0 · 14 s": a test result is told only from the exit code
function runOutcome(o: Record<string, unknown>) {
  if (o.status === "running" || typeof o.durationMs !== "number") return ""
  const ms = o.durationMs
  const took = `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  if (o.timedOut) return `✗ timed out · ${took}`
  if (typeof o.exitCode !== "number") return `✗ stopped · ${took}`
  return `${o.exitCode === 0 ? "✓" : "✗"} exit ${o.exitCode} · ${took}`
}

const ref = (i: Record<string, unknown>) =>
  str(i.repo) && i.number ? `${str(i.repo)}#${i.number}` : str(i.repo)

// A8 writes: the exact public action, field by field, then its long text
const cellRows = (rows: unknown) =>
  Array.isArray(rows) ? rows.map((r) => (Array.isArray(r) ? r.join("\t") : "")) : []
const A8_ROWS: Record<string, (i: Record<string, unknown>) => [string, string][]> = {
  github_comment: (i) => [["On", ref(i)]],
  github_create_issue: (i) => [
    ["Repository", str(i.repo)],
    ["Title", str(i.title)],
  ],
  github_label: (i) => [
    ["On", ref(i)],
    ["Labels", list(i.labels)],
  ],
  github_open_pr: (i) => [
    ["Repository", str(i.repo)],
    ["Branch", `${str(i.branch)} → ${str(i.base) || "default branch"}`],
    ["Title", str(i.title)],
    ["Files", Array.isArray(i.files) ? i.files.map((f) => str(f?.path)).join(", ") : ""],
  ],
  sheets_append: (i) => [
    ["Spreadsheet", str(i.spreadsheetId)],
    ["After", str(i.range)],
    ["Rows", String(cellRows(i.rows).length)],
  ],
  sheets_update: (i) => [
    ["Spreadsheet", str(i.spreadsheetId)],
    ["Overwrites", str(i.range)],
  ],
  sheets_create: (i) => [
    ["Title", str(i.title)],
    ["Tabs", Array.isArray(i.tabs) ? i.tabs.map((t) => str(t?.name)).join(", ") : ""],
  ],
  instagram_publish: (i) => [
    ["Image", str(i.imageUrl)],
    ["Caption", str(i.caption)],
  ],
  drive_share: (i) => [
    ["File", str(i.fileId)],
    ["People", list(i.emails)],
    ["Access", i.role === "commenter" ? "Can comment" : "Can view"],
  ],
  gmail_send_draft: (i) => [["Draft", str(i.draftId)]],
  calendar_delete_event: (i) => [
    ["Event", str(i.title)],
    ["Starts", str(i.start)],
    ["Guests", list(i.attendees) || "None"],
  ],
  workspace_publish: (i) => [
    ["Repository", str(i.repo)],
    ["New branch", str(i.branch)],
    ["Title", str(i.title)],
    ["Changes", "Exactly the files listed in the last workspace changes"],
  ],
}
const A8_TEXT: Record<string, (i: Record<string, unknown>) => string> = {
  github_comment: (i) => str(i.body),
  github_create_issue: (i) => str(i.body),
  workspace_publish: (i) => str(i.body),
  github_open_pr: (i) =>
    Array.isArray(i.files)
      ? i.files.map((f) => `── ${str(f?.path)}\n${str(f?.content)}`).join("\n\n")
      : "",
  sheets_append: (i) => cellRows(i.rows).join("\n"),
  sheets_update: (i) => cellRows(i.rows).join("\n"),
  sheets_create: (i) =>
    Array.isArray(i.tabs)
      ? i.tabs
          .map(
            (t) =>
              `── ${str(t?.name)}\n${Array.isArray(t?.columns) ? t.columns.map((c: { name?: unknown; type?: unknown }) => `${str(c?.name)} (${str(c?.type)})`).join("\t") : ""}`
          )
          .join("\n\n")
      : "",
}
const A8_NOTES: Record<string, string> = {
  github_comment: "Posted on GitHub as you. Anyone who can see the repository sees it.",
  github_create_issue:
    "Opened on GitHub as you. Anyone who can see the repository sees it.",
  github_label: "Added on GitHub as you; people watching the issue may be notified.",
  github_open_pr:
    "A new branch and a pull request on GitHub, as you. Nothing is merged: you or the maintainers decide.",
  sheets_append: "Added to your Google Sheet as plain values, never formulas.",
  sheets_update: "Replaces those cells in your Google Sheet with these plain values.",
  sheets_create:
    "A new spreadsheet in your Google Drive. Only you can see it until you share it.",
  instagram_publish: "Posted publicly on your Instagram as you.",
  drive_share:
    "Google emails each of them a link. You can undo it for 10 minutes; after that, remove access in Drive.",
  gmail_send_draft:
    "Sends the draft exactly as saved in your Gmail, as you. A sent email can't be taken back.",
  calendar_delete_event:
    "Deletes this event from your Google Calendar. Guests aren't emailed, but it disappears from their calendars too. It can't be undone.",
  workspace_publish:
    "Kriya will create this branch and a draft pull request on GitHub as you. Nothing is merged.",
}

export function toolName(part: ToolPart) {
  return part.type.slice("tool-".length)
}

function Pre({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-md border bg-background/70 px-3 py-2 font-code text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90",
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

  if (name.startsWith("workspace_")) {
    return <WorkspaceDetails name={name} input={input} output={output} />
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
    case "memory_update":
      return <p className="text-[13px]">{str(input.note)}</p>
    case "kit_prepare":
      return output?.done ? <KitCard input={input} output={output} /> : null
    // A drafted call: nobody is rung until the person confirms it there
    case "propose_call":
      return output && /^\/calls\/[0-9a-f-]{36}$/.test(str(output.href)) ? (
        <a
          href={str(output.href)}
          className="text-[13px] font-medium text-rigel hover:underline"
        >
          Review and confirm the call to {str(input.recipientLabel)}
        </a>
      ) : output ? (
        <p className="text-[13px]">{str(output.error)}</p>
      ) : null
    // A proposal: nothing is granted until the person approves it there
    case "mandate_propose":
      return output?.mandateId ? (
        <a href="/inbox" className="text-[13px] font-medium text-rigel hover:underline">
          Review and approve the job &ldquo;{str(input.title)}&rdquo; in your Inbox
        </a>
      ) : output ? (
        <p className="text-[13px]">{str(output.error)}</p>
      ) : null
    // Each part's member, brief and thread; live status is on the job's page
    case "crew_dispatch":
      return Array.isArray(output?.parts) ? (
        <ul className="flex flex-col gap-2">
          {(output.parts as Record<string, unknown>[]).map((p) => {
            const brief = (Array.isArray(input.parts) ? input.parts : []).find(
              (i: Record<string, unknown>) => i?.key === p.key
            )
            const href = `/a/${encodeURIComponent(str(p.agentId))}/${encodeURIComponent(str(p.threadId))}`
            return (
              <li key={str(p.key)} className="flex flex-col gap-0.5">
                <a
                  href={href}
                  className="text-[13px] font-medium text-rigel hover:underline"
                >
                  {str(p.name)} · {str(p.key)}
                </a>
                <p className="text-[12.5px] text-muted-foreground">{str(brief?.brief)}</p>
              </li>
            )
          })}
        </ul>
      ) : output ? (
        <p className="text-[13px]">{str(output.error)}</p>
      ) : null
    default:
      return (
        <div className="flex flex-col gap-2">
          <Pre>{JSON.stringify(input, null, 2)}</Pre>
          {output && <Pre>{JSON.stringify(output, null, 2)}</Pre>}
        </div>
      )
  }
}

// A diff or file text, each line marked by its +/− prefix as well as colour
function DiffPre({ text }: { text: string }) {
  return (
    <Pre>
      {text.split("\n").map((line, index) => (
        <span
          key={index}
          className={cn(
            "block",
            /^\+(?!\+\+)/.test(line) && "bg-ok/10 text-ok",
            /^-(?!--)/.test(line) && "bg-destructive/10 text-destructive"
          )}
        >
          {line || " "}
        </span>
      ))}
    </Pre>
  )
}

const firstLines = (text: string, n = 40) => {
  const lines = text.split("\n")
  return lines.length > n
    ? `${lines.slice(0, n).join("\n")}\n… ${lines.length - n} more lines`
    : text
}

// Track C's workspace cards (UX_SPEC §3). Output is plain text in a <pre>,
// never HTML; the untrusted-content notice for the model isn't shown
export function WorkspaceDetails({
  name,
  input,
  output,
}: {
  name: string
  input: Record<string, unknown>
  output: Record<string, unknown> | null
}) {
  if (output && typeof output.error === "string") {
    return <p className="text-[13px] text-destructive">{output.error}</p>
  }
  switch (name) {
    case "workspace_open":
      return output ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">Project</dt>
          <dd className="min-w-0 break-words">{str(output.repo) || "Blank project"}</dd>
          {str(output.ref) && (
            <>
              <dt className="text-muted-foreground">Branch</dt>
              <dd>{str(output.ref)}</dd>
            </>
          )}
          {str(output.baseSha) && (
            <>
              <dt className="text-muted-foreground">Base commit</dt>
              <dd className="font-mono text-[12px]">
                {str(output.baseSha).slice(0, 12)}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">State</dt>
          <dd>
            {output.restored
              ? "Restored from the last save"
              : output.status === "running"
                ? "Ready"
                : str(output.status)}
          </dd>
        </dl>
      ) : null
    case "workspace_run": {
      if (!output) return <Pre>$ {str(input.command)}</Pre>
      if (output.status === "running") {
        return (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted-foreground">
              Running… latest output
            </span>
            <Pre>{str(output.tail) || " "}</Pre>
          </div>
        )
      }
      return (
        <div className="flex flex-col gap-1.5">
          <Pre>$ {str(input.command)}</Pre>
          {str(output.stdout) && <Pre>{str(output.stdout)}</Pre>}
          {str(output.stderr) && (
            <Pre className="text-betelgeuse">{str(output.stderr)}</Pre>
          )}
          <span className="text-[12px] text-muted-foreground">
            {output.truncated ? "Long output: its start and end are shown. " : ""}
            Full log saved in the workspace.
          </span>
        </div>
      )
    }
    case "workspace_read":
      return output && typeof output.text === "string" ? (
        <Pre>{firstLines(output.text)}</Pre>
      ) : output ? (
        <p className="text-[13px]">
          A binary file ({String(output.bytes ?? "?")} bytes).
        </p>
      ) : null
    case "workspace_write":
      return (
        <div className="flex flex-col gap-1.5">
          {output && (
            <span className="text-[12px] text-muted-foreground">
              {output.created ? "Created" : "Replaced"} {str(input.path)}
            </span>
          )}
          <DiffPre text={firstLines(str(input.content)).replace(/^/gm, "+")} />
        </div>
      )
    case "workspace_edit":
      return (
        <DiffPre
          text={`${str(input.oldText).replace(/^/gm, "-")}\n${str(input.newText).replace(/^/gm, "+")}`}
        />
      )
    case "workspace_patch":
      return <DiffPre text={str(input.patch)} />
    case "workspace_search":
      return Array.isArray(output?.matches) ? (
        <Pre>
          {(output.matches as { path: string; line: number; text: string }[])
            .map((m) => `${m.path}:${m.line}  ${m.text}`)
            .join("\n") || "No matches"}
        </Pre>
      ) : null
    case "workspace_list":
      return Array.isArray(output?.entries) ? (
        <Pre>
          {(output.entries as { path: string; type: string }[])
            .map((e) => (e.type === "dir" ? `${e.path}/` : e.path))
            .join("\n") || "Empty"}
        </Pre>
      ) : null
    case "workspace_changes":
      return Array.isArray(output?.files) ? (
        <div className="flex flex-col gap-1.5">
          <ul className="flex flex-col gap-0.5 font-mono text-[12px]">
            {(
              output.files as {
                path: string
                status: string
                added: number
                removed: number
              }[]
            ).map((f) => (
              <li key={f.path} className="flex min-w-0 gap-2">
                <span className="min-w-0 truncate">{f.path}</span>
                <span className="ml-auto shrink-0 text-ok">+{f.added}</span>
                <span className="shrink-0 text-destructive">−{f.removed}</span>
              </li>
            ))}
          </ul>
          {str(output.diff) && (
            <Collapsible>
              <CollapsibleTrigger className="min-h-11 text-[12.5px] text-rigel hover:underline sm:min-h-8">
                Show the diff
              </CollapsibleTrigger>
              <CollapsibleContent>
                <DiffPre text={str(output.diff)} />
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      ) : null
    case "workspace_publish": {
      const href = output && safeHref(str(output.url))
      return href ? (
        <div className="flex flex-col gap-1">
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[13px] font-medium break-all text-rigel hover:underline"
          >
            Draft pull request #{String(output.number)} in {str(output.repo)} ↗
          </a>
          <span className="text-[12px] text-muted-foreground">
            {(output.verification as { status?: string } | undefined)?.status ===
            "verified"
              ? "Checked on GitHub: the draft pull request is open."
              : "Not confirmed on GitHub yet."}
          </span>
        </div>
      ) : null
    }
    default:
      return null
  }
}

// Sends a message as the person; provided by the thread view
export const SendContext = React.createContext<((text: string) => void) | null>(null)

// K9: the person copies each field into the site, then says it's applied;
// the agent's kit_check reads the page to verify it (AT-KIT-02)
function KitCard({
  input,
  output,
}: {
  input: Record<string, unknown>
  output: Record<string, unknown>
}) {
  const send = React.useContext(SendContext)
  const [copied, setCopied] = React.useState<number | null>(null)
  const fields = Array.isArray(input.fields)
    ? (input.fields as { label?: unknown; text?: unknown }[])
    : []
  const limits = Array.isArray(output.limits) ? (output.limits as (number | null)[]) : []
  const checklist = Array.isArray(input.checklist) ? input.checklist : []
  const link = safeHref(str(input.deepLink))
  return (
    <div className="flex flex-col gap-3">
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[13px] font-medium break-all text-rigel hover:underline"
        >
          Open the form ↗
        </a>
      )}
      <ol className="flex flex-col gap-3">
        {fields.map((field, index) => {
          const text = str(field.text)
          const limit = limits[index]
          return (
            <li key={index} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">{str(field.label)}</span>
                <span className="font-mono text-[10.5px] text-faint">
                  {text.length}
                  {typeof limit === "number" ? ` / ${limit}` : ""} characters
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="ml-auto min-h-11 sm:min-h-6"
                  onClick={() => {
                    void navigator.clipboard?.writeText(text).then(() => setCopied(index))
                  }}
                >
                  {copied === index ? "Copied" : "Copy"}
                </Button>
              </div>
              <Pre>{text}</Pre>
            </li>
          )
        })}
      </ol>
      {checklist.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px]">
          {checklist.map((item, index) => (
            <li key={index}>{str(item)}</li>
          ))}
        </ul>
      )}
      {send && typeof output.kitId === "string" && (
        <Button
          type="button"
          className="min-h-11 self-start"
          onClick={() =>
            send(
              `I've applied the kit "${str(input.title)}". Please check it (kit ${output.kitId}).`
            )
          }
        >
          I&apos;ve applied it
        </Button>
      )}
    </div>
  )
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
            : (A8_ROWS[name]?.(input) ?? [["Details", JSON.stringify(input)]])
  const note =
    name === "calendar_create_event"
      ? list(input.attendees)
        ? "Added to your Google Calendar. Google emails an invite to each guest."
        : "Added to your Google Calendar. No one else is notified."
      : name === "gmail_draft"
        ? "Saved as a draft in your Gmail. Nothing is sent: you send it yourself."
        : name === "web_fetch" || name === "web_search"
          ? "Your private mail or documents are in this conversation, so web requests need your ok. Check that the address or search doesn't carry anything private."
          : (A8_NOTES[name] ?? "This changes something outside Kriya.")

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
      {A8_TEXT[name]?.(input) && <Pre className="max-h-48">{A8_TEXT[name](input)}</Pre>}
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
  // A streaming tool's interim output (workspace_run) is still running
  const preliminary =
    part.state === "output-available" &&
    (part as { preliminary?: boolean }).preliminary === true
  const pending =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "approval-responded" && !declined) ||
    preliminary
  // A call still pending after its task ended was cut off by a stop or a failure
  const running = pending && live
  const interrupted = pending && !live
  const failed = part.state === "output-error"
  const outcome =
    part.state === "output-available" && !preliminary && meta.outcome
      ? meta.outcome((part.output ?? {}) as Record<string, unknown>)
      : ""
  const summary = [meta.summary?.((part.input ?? {}) as Record<string, unknown>), outcome]
    .filter(Boolean)
    .join(" · ")
  // A drafted call's summary lands in this thread when it's over (voice D-23);
  // mounted beside the card, which is collapsed by default
  const callHref =
    name === "propose_call" && part.state === "output-available"
      ? str((part.output as Record<string, unknown> | undefined)?.href)
      : ""
  const watch = /^\/calls\/[0-9a-f-]{36}$/.test(callHref) && (
    <ThreadCallWatch taskId={callHref.slice("/calls/".length)} />
  )

  return (
    <Collapsible className="group/tool">
      {watch}
      <CollapsibleTrigger
        className={cn(
          "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left font-mono text-[12px] transition-colors hover:border-border hover:bg-accent/40",
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
