"use client"

import * as React from "react"
import Link from "next/link"
import { formatDistanceToNowStrict } from "date-fns"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileEditIcon,
  GlobeIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react"

import type { LiveFeed, LiveSession } from "@/lib/harness/live"
import { cn } from "@/lib/utils"

// Remote Control (REMOTE_CONTROL.md): sessions the person switched on in Kriya
// Harness, followed here. Device text is shown as plain text, never as HTML
// or markdown.

const POLL_MS = 2500

function stateOf(session: LiveSession) {
  if (!session.remote) return { label: "Remote Control off", tone: "text-faint" }
  if (session.lost) return { label: "Lost contact", tone: "text-betelgeuse" }
  return {
    running: { label: "Working", tone: "text-rigel" },
    waiting: { label: "Waiting for you", tone: "text-betelgeuse" },
    idle: { label: "Idle", tone: "text-muted-foreground" },
    ended: { label: "Ended", tone: "text-faint" },
  }[session.state]
}

const nameOf = (session: LiveSession) =>
  session.title || session.project || "Kriya Harness session"

export function LiveList({ initial }: { initial: LiveSession[] }) {
  const [rows, setRows] = React.useState(initial)
  React.useEffect(() => {
    const timer = setInterval(async () => {
      if (document.visibilityState !== "visible") return
      const res = await fetch("/harness/live-data", { cache: "no-store" }).catch(
        () => null
      )
      if (res?.ok) setRows((await res.json()) as LiveSession[])
    }, 5000)
    return () => clearInterval(timer)
  }, [])
  if (!rows.length)
    return (
      <p className="glass rounded-[20px] px-4 py-5 text-center text-[13px] leading-relaxed text-muted-foreground">
        Nothing yet. In Kriya Harness, open a session&apos;s Overview tab and turn on
        Remote Control.
      </p>
    )
  return (
    <ul className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
      {rows.map((row) => {
        const state = stateOf(row)
        return (
          <li key={row.id}>
            <Link
              href={`/harness/live/${row.id}`}
              className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                <span className="truncate text-[13.5px] font-medium">{nameOf(row)}</span>
                <span className="truncate text-[12px] text-muted-foreground">
                  {row.device}
                  {row.project && ` · ${row.project}`}
                </span>
              </span>
              <span className={cn("shrink-0 font-mono text-[10.5px]", state.tone)}>
                {state.label}
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-faint" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

type Event = LiveFeed["events"][number]
type Data = { text?: string; callId?: string; tool?: string; target?: string }
type EndData = Data & { status?: "ok" | "error" | "declined"; ms?: number }

function ToolIcon({ tool = "" }: { tool?: string }) {
  const className = "mt-0.5 size-3.5 shrink-0 text-rigel"
  if (tool.startsWith("browser")) return <GlobeIcon className={className} />
  if (/edit|write|replace/.test(tool)) return <FileEditIcon className={className} />
  if (/bash|shell|terminal|pwsh/.test(tool)) return <TerminalIcon className={className} />
  return <WrenchIcon className={className} />
}

function ToolRow({ start, end }: { start: Event; end?: Event }) {
  const data = start.data as Data
  const done = end?.data as EndData | undefined
  return (
    <li className="flex items-start gap-2.5 px-1 py-1.5 text-[12.5px]">
      <ToolIcon tool={data.tool} />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{data.tool}</span>
        {data.target && (
          <span className="block font-mono text-[11.5px] break-all text-muted-foreground">
            {data.target}
          </span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[10.5px]",
          !done
            ? "text-rigel"
            : done.status === "ok"
              ? "text-muted-foreground"
              : "text-destructive"
        )}
      >
        {!done
          ? "running"
          : done.status === "ok"
            ? done.ms && done.ms >= 1000
              ? `${(done.ms / 1000).toFixed(1)} s`
              : "done"
            : done.status === "declined"
              ? "declined"
              : "failed"}
      </span>
    </li>
  )
}

export function LiveView({ initial }: { initial: LiveFeed }) {
  const [session, setSession] = React.useState(initial.session)
  const [events, setEvents] = React.useState(initial.events)
  const last = React.useRef(initial.events.at(-1)?.seq ?? -1)
  const follow = React.useRef(true)
  const scroller = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const timer = setInterval(async () => {
      if (document.visibilityState !== "visible") return
      const query = new URLSearchParams({
        session: initial.session.id,
        after: String(last.current),
      })
      const res = await fetch(`/harness/live-data?${query}`, {
        cache: "no-store",
      }).catch(() => null)
      if (!res?.ok) return
      const fresh = (await res.json()) as LiveFeed
      setSession(fresh.session)
      if (fresh.events.length) {
        last.current = fresh.events.at(-1)!.seq
        setEvents((old) => [...old, ...fresh.events].slice(-1500))
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [initial.session.id])

  React.useEffect(() => {
    const box = scroller.current
    if (box && follow.current) box.scrollTop = box.scrollHeight
  }, [events])

  const ends = new Map(
    events
      .filter((event) => event.kind === "tool_end")
      .map((event) => [(event.data as Data).callId, event])
  )
  const state = stateOf(session)

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const box = e.currentTarget
        follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
        <header className="flex flex-col gap-2">
          <Link
            href="/harness"
            className="flex min-h-11 w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground sm:min-h-8"
          >
            <ChevronLeftIcon className="size-3.5" />
            Kriya Harness
          </Link>
          <h1 className="font-display text-[24px] leading-tight font-normal text-balance">
            {nameOf(session)}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
            <span className={cn("font-medium", state.tone)} role="status">
              {state.label}
            </span>
            <span>
              {session.device}
              {session.project && ` · ${session.project}`} · updated{" "}
              {formatDistanceToNowStrict(new Date(session.updatedAt), {
                addSuffix: true,
              })}
            </span>
          </p>
        </header>
        {events.length === 0 ? (
          <p className="glass rounded-[20px] px-4 py-5 text-center text-[13px] text-muted-foreground">
            Connected. What the agent does next shows up here.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((event) => {
              const data = event.data as Data
              if (event.kind === "tool_start")
                return (
                  <ToolRow key={event.seq} start={event} end={ends.get(data.callId)} />
                )
              if (event.kind === "tool_end") return null
              return (
                <li
                  key={event.seq}
                  className={cn(
                    "rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap",
                    event.kind === "user" ? "my-1 self-end bg-rigel-soft" : "glass my-1"
                  )}
                >
                  {data.text}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
