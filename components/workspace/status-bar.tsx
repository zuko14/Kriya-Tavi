"use client"

import Link from "next/link"
import { BellIcon, BellOffIcon } from "lucide-react"

import { useWorkspace } from "@/components/workspace/context"
import { useNotifications } from "@/components/workspace/notifier"
import { formatInr } from "@/lib/money"
import { cn } from "@/lib/utils"

function Dot({ on, warn }: { on: boolean; warn?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 rounded-full",
        on ? "bg-ok" : warn ? "bg-betelgeuse" : "bg-faint/60"
      )}
    />
  )
}

function Cell({
  children,
  href,
  title,
  className,
}: {
  children: React.ReactNode
  href?: string
  title?: string
  className?: string
}) {
  const classes = cn(
    "flex h-full items-center gap-1.5 px-2.5 whitespace-nowrap transition-colors",
    href && "hover:bg-accent/60 hover:text-foreground",
    className
  )
  return href ? (
    <Link href={href} title={title} className={classes}>
      {children}
    </Link>
  ) : (
    <span title={title} className={classes}>
      {children}
    </span>
  )
}

function NotificationsToggle() {
  const { enabled, permission, toggle } = useNotifications()
  const blocked = enabled && permission === "denied"
  const unasked = enabled && permission === "default"
  return (
    <button
      type="button"
      onClick={toggle}
      title={
        !enabled
          ? "Alerts off. Click for a sound and a notification when an agent finishes"
          : unasked
            ? "Sound is on. Click to allow notifications too."
            : blocked
              ? "Sound on. Notifications are blocked for this site in your browser settings."
              : "Alerts on: sound and notifications. Click to mute."
      }
      className="flex h-full items-center gap-1.5 px-2.5 whitespace-nowrap transition-colors hover:bg-accent/60 hover:text-foreground"
    >
      {enabled ? (
        <BellIcon
          className={cn("size-3", blocked || unasked ? "text-warn" : "text-ok")}
        />
      ) : (
        <BellOffIcon className="size-3" />
      )}
      <span className="max-sm:hidden">
        {!enabled ? "alerts off" : unasked ? "allow alerts" : "alerts on"}
      </span>
    </button>
  )
}

export function StatusBar() {
  const { status } = useWorkspace()

  return (
    <footer className="flex h-7 shrink-0 items-stretch overflow-x-auto border-t bg-surface/60 font-mono text-[10.5px] text-muted-foreground max-md:hidden">
      <Cell href="/account#plan" title="Your plan">
        <Dot on={!status.usage.blocked} warn />
        {status.plan.name.toLowerCase()} · {status.usage.tasksToday}/
        {status.plan.maxTasksPerDay} tasks today
      </Cell>
      <Cell href="/usage" title="AI usage this period, in rupees">
        {formatInr(status.usage.usedMicroInr)} used
      </Cell>
      <Cell title="Web research through Firecrawl">
        <Dot on={status.web} />
        web {status.web ? "on" : "off"}
      </Cell>
      <span className="flex-1" />
      {status.running.length > 0 && (
        <Cell className="text-rigel">
          <span className="size-1.5 animate-pulse-dot rounded-full bg-rigel text-rigel" />
          {status.running.length} running
        </Cell>
      )}
      <NotificationsToggle />
      <Cell title={status.ready ? "Models reachable" : "Models unreachable"}>
        <Dot on={status.ready} warn />
        kriya
      </Cell>
    </footer>
  )
}
