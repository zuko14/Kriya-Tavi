import type { Metadata } from "next"
import Link from "next/link"
import { formatDistanceToNowStrict } from "date-fns"
import {
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  LoaderIcon,
  OctagonXIcon,
} from "lucide-react"

import { Glyph } from "@/components/glyph"
import { requireUser } from "@/lib/auth"
import { formatInr } from "@/lib/money"
import { tierName } from "@/lib/tiers"
import { cn } from "@/lib/utils"
import { getTasks, type TaskRow } from "@/queries/workspace"

export const metadata: Metadata = { title: "Tasks" }

// Live without polling: the notifier refreshes the page on every task event

const STATUS = {
  queued: { label: "queued", icon: ClockIcon, tone: "text-muted-foreground" },
  running: { label: "working", icon: LoaderIcon, tone: "text-rigel" },
  succeeded: { label: "done", icon: CircleCheckIcon, tone: "text-ok" },
  failed: { label: "failed", icon: CircleXIcon, tone: "text-destructive" },
  canceled: { label: "stopped", icon: OctagonXIcon, tone: "text-muted-foreground" },
} as const

function took(task: TaskRow) {
  if (!task.startedAt || !task.finishedAt) return null
  const s = Math.round((task.finishedAt.getTime() - task.startedAt.getTime()) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function TaskItem({ task }: { task: TaskRow }) {
  const status = STATUS[task.status]
  const Icon = status.icon
  const href = task.squadId
    ? `/s/${task.squadId}/${task.threadId}`
    : `/a/${task.agentId}/${task.threadId}`
  const duration = took(task)
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
      >
        <span className="relative shrink-0">
          {task.agentGlyph ? (
            <Glyph seed={task.agentGlyph} className="size-9" />
          ) : (
            <span className="block size-9 rounded-lg bg-muted" />
          )}
          <span
            className={cn(
              "absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full bg-background",
              status.tone
            )}
          >
            <Icon
              className={cn("size-3.5", task.status === "running" && "animate-spin")}
            />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
          <span className="truncate text-[14px] font-medium">
            {task.threadTitle ?? "New thread"}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {task.agentName ?? "Deleted agent"}
            {task.squadName && ` · ${task.squadName}`} ·{" "}
            {formatDistanceToNowStrict(task.createdAt, { addSuffix: true })}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] leading-tight">
          <span className={status.tone}>{status.label}</span>
          <span className="text-faint tabular-nums">
            {task.charge != null
              ? `${formatInr(task.charge)}${task.chargeStatus === "estimated" ? " est." : ""}`
              : (duration ?? tierName(task.tier).toLowerCase())}
          </span>
        </span>
      </Link>
    </li>
  )
}

function Group({
  title,
  tasks,
  empty,
}: {
  title: string
  tasks: TaskRow[]
  empty?: string
}) {
  if (tasks.length === 0 && !empty) return null
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-1">
        <h2 className="label-mono">{title}</h2>
        <span className="font-mono text-[10px] text-faint tabular-nums">
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="glass rounded-[20px] px-4 py-4 text-[13px] text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="glass divide-y overflow-hidden rounded-[20px]">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} />
          ))}
        </ul>
      )}
    </section>
  )
}

export default async function Page() {
  const user = await requireUser()
  const all = await getTasks(user.id)
  const active = all.filter((t) => t.status === "queued" || t.status === "running")
  const failed = all.filter((t) => t.status === "failed")
  const finished = all.filter((t) => t.status === "succeeded" || t.status === "canceled")

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
            Tasks
          </h1>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Everything your agents are doing and have done. Tasks keep running when you
            close the app, and this list updates as they finish.
          </p>
        </header>

        {all.length === 0 ? (
          <div className="glass flex flex-col items-center gap-3 rounded-[24px] px-6 py-12 text-center">
            <p className="text-[15px] font-medium">No tasks yet</p>
            <p className="max-w-sm text-[13px] text-muted-foreground">
              Give an agent something to do from Home and it shows up here.
            </p>
            <Link
              href="/home"
              className="btn-liquid mt-2 inline-flex h-11 items-center px-5 text-[14px]"
            >
              Give a task
            </Link>
          </div>
        ) : (
          <>
            <Group
              title="working now"
              tasks={active}
              empty="Nothing running. Your agents are free."
            />
            <Group title="needs a look" tasks={failed} />
            <Group title="finished" tasks={finished} />
          </>
        )}
      </div>
    </div>
  )
}
