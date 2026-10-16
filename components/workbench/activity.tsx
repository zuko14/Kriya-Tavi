"use client"

import * as React from "react"
import { formatDistanceToNowStrict } from "date-fns"
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleSlashIcon,
  RotateCcwIcon,
  XCircleIcon,
} from "lucide-react"

import { threadActivity } from "@/actions/threads"
import { Spinner } from "@/components/ui/spinner"
import { formatInr } from "@/lib/money"
import { tierName } from "@/lib/tiers"
import { cn } from "@/lib/utils"
import type { Activity } from "@/queries/workspace"

const STATUS = {
  queued: {
    icon: CircleDashedIcon,
    label: "Waiting to start",
    tone: "text-muted-foreground",
  },
  running: { icon: Spinner, label: "Working", tone: "text-rigel" },
  succeeded: { icon: CheckCircle2Icon, label: "Done", tone: "text-ok" },
  failed: { icon: XCircleIcon, label: "Failed", tone: "text-destructive" },
  canceled: {
    icon: CircleSlashIcon,
    label: "Stopped by you",
    tone: "text-muted-foreground",
  },
} as const

const TOOL_LABELS: Record<string, string> = {
  web_search: "Searched the web",
  web_fetch: "Read a page",
  memory_write: "Saved to memory",
  memory_forget: "Removed a memory",
  delegate: "Handed over",
  assign: "Split the work across the squad",
  calendar_events: "Checked the calendar",
  calendar_create_event: "Added a calendar event",
  gmail_search: "Searched Gmail",
  gmail_read: "Read an email",
  gmail_draft: "Saved a Gmail draft",
  drive_search: "Searched Drive",
  drive_read: "Read a Drive file",
  notion_search: "Searched Notion",
  notion_read: "Read a Notion page",
}

// What each tool sets out to do, for rows still running or that failed
const TOOL_ACTIONS: Record<string, string> = {
  web_search: "search the web",
  web_fetch: "read a page",
  memory_write: "save to memory",
  memory_forget: "remove a memory",
  delegate: "hand over",
  assign: "split the work across the squad",
  calendar_events: "check the calendar",
  calendar_create_event: "add a calendar event",
  gmail_search: "search Gmail",
  gmail_read: "read an email",
  gmail_draft: "save a Gmail draft",
  drive_search: "search Drive",
  drive_read: "read a Drive file",
  notion_search: "search Notion",
  notion_read: "read a Notion page",
}

// A label that matches what happened: "Added…", "Add…" while running, "Couldn't add…"
function toolLabel(name: string, status: string) {
  const action = TOOL_ACTIONS[name] ?? name
  if (status === "failed") return `Couldn't ${action}`
  if (status === "running") return `${action[0].toUpperCase()}${action.slice(1)}…`
  return TOOL_LABELS[name] ?? name
}

function seconds(from: Date | null, to: Date | null) {
  if (!from || !to) return null
  const s = (new Date(to).getTime() - new Date(from).getTime()) / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

// A thread's tasks as a timeline: what ran, on which model, what each tool
// did, and what it cost. The record behind every answer.
export function ActivityPanel({
  threadId,
  refreshKey,
}: {
  threadId: string
  refreshKey: number
}) {
  const [tasks, setTasks] = React.useState<Activity | null>(null)
  const [error, setError] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    threadActivity(threadId)
      .then((rows) => {
        if (!alive) return
        setTasks(rows)
        setError(false)
      })
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [threadId, refreshKey])

  if (error) {
    return (
      <p className="p-4 text-[13px] text-muted-foreground">
        Couldn&apos;t load activity.
      </p>
    )
  }
  if (!tasks) {
    return (
      <div className="grid place-items-center p-8">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }
  if (tasks.length === 0) {
    return (
      <p className="p-4 text-[13px] leading-relaxed text-muted-foreground">
        Nothing yet. Each task you give this agent shows up here with every step it took
        and what it cost.
      </p>
    )
  }

  return (
    <ol className="flex flex-col gap-3 p-3">
      {tasks.map((task) => {
        const status = STATUS[task.status]
        const Icon = status.icon
        const took = seconds(task.startedAt, task.finishedAt)
        return (
          <li
            key={task.id}
            className="flex flex-col gap-2.5 rounded-lg border bg-surface p-3"
          >
            <div className="flex items-center gap-2">
              <Icon className={cn("size-4 shrink-0", status.tone)} />
              <span className="text-[13px] font-medium">{status.label}</span>
              <span className="ml-auto font-mono text-[10.5px] text-faint">
                {formatDistanceToNowStrict(new Date(task.createdAt), { addSuffix: true })}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
              <dt className="text-muted-foreground">model</dt>
              <dd className="truncate" title={task.model ?? undefined}>
                {tierName(task.tier)}
              </dd>
              {took && (
                <>
                  <dt className="text-muted-foreground">took</dt>
                  <dd>{took}</dd>
                </>
              )}
              <dt className="text-muted-foreground">model calls</dt>
              <dd>
                {task.usage.n} ·{" "}
                {(task.usage.input + task.usage.output).toLocaleString("en-IN")} tokens
              </dd>
              <dt className="text-muted-foreground">cost</dt>
              <dd>
                {task.chargeStatus === "unpriced" || task.chargeMicroInr == null
                  ? task.status === "running" || task.status === "queued"
                    ? "counting…"
                    : "not priced"
                  : formatInr(task.chargeMicroInr)}
                {task.chargeStatus === "estimated" && (
                  <span
                    className="text-betelgeuse"
                    title="Includes estimated provider costs"
                  >
                    {" "}
                    est.
                  </span>
                )}
              </dd>
              {task.attempts > 1 && (
                <>
                  <dt className="text-muted-foreground">attempts</dt>
                  <dd className="flex items-center gap-1">
                    <RotateCcwIcon className="size-3" />
                    {task.attempts}
                  </dd>
                </>
              )}
            </dl>
            {task.tools.length > 0 && (
              <ul className="flex flex-col gap-1.5 border-t pt-2.5">
                {task.tools.map((tool) => (
                  <li key={tool.id} className="flex flex-col gap-0.5 text-[12px]">
                    <span className="flex items-center gap-1.5">
                      {tool.status === "succeeded" ? (
                        <CheckCircle2Icon className="size-3.5 text-ok" />
                      ) : tool.status === "failed" ? (
                        <XCircleIcon className="size-3.5 text-destructive" />
                      ) : (
                        <Spinner className="size-3.5 text-rigel" />
                      )}
                      {toolLabel(tool.toolName, tool.status)}
                      {tool.durationMs != null && (
                        <span className="ml-auto font-mono text-[10.5px] text-faint">
                          {(tool.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </span>
                    {tool.error && (
                      <span className="pl-5 text-[11.5px] text-destructive">
                        {tool.error}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {task.status === "failed" && task.error && (
              <p className="rounded-md bg-destructive/5 px-2.5 py-1.5 text-[12px] text-destructive">
                {task.error}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}
