"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { differenceInCalendarDays } from "date-fns"
import {
  ActivityIcon,
  HouseIcon,
  ListChecksIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SquarePenIcon,
  SunIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { useTheme } from "next-themes"

import { deleteThread } from "@/actions/threads"
import { LogoMark, Wordmark } from "@/components/brand"
import { Confirm } from "@/components/confirm"
import { Glyph, SquadGlyph } from "@/components/glyph"
import { useWorkspace } from "@/components/workspace/context"
import { Kbd } from "@/components/ui/kbd"
import { toast } from "@/components/ui/toast"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

function Section({
  label,
  count,
  onAdd,
  addLabel,
  children,
}: {
  label: string
  count?: number
  onAdd?: () => void
  addLabel?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-px px-2 pt-4">
      <div className="flex h-6 items-center gap-2 px-2">
        <h2 className="label-mono">{label}</h2>
        {count !== undefined && (
          <span className="font-mono text-[10px] text-faint tabular-nums">{count}</span>
        )}
        {onAdd && (
          <Tooltip>
            <TooltipTrigger
              onClick={onAdd}
              aria-label={addLabel}
              className="ml-auto grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:-mr-3 max-md:size-11"
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="right">{addLabel}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
    </section>
  )
}

function Item({
  href,
  active,
  icon,
  title,
  subtitle,
  busy,
  onNavigate,
}: {
  href: string
  active: boolean
  icon: React.ReactNode
  title: string
  subtitle?: string | null
  busy?: boolean
  onNavigate?: () => void
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors max-md:min-h-12",
        active ? "bg-accent text-foreground" : "text-foreground/85 hover:bg-accent/60"
      )}
    >
      {active && (
        <span className="absolute top-1.5 bottom-1.5 -left-2 w-[2px] rounded-full bg-rigel" />
      )}
      {icon}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {subtitle && (
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
      {busy && (
        <span
          title="Working"
          className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-rigel text-rigel"
        />
      )}
    </Link>
  )
}

function bucket(iso: string) {
  const days = differenceInCalendarDays(new Date(), new Date(iso))
  return days <= 0
    ? "Today"
    : days === 1
      ? "Yesterday"
      : days < 7
        ? "Previous 7 days"
        : days < 30
          ? "Previous 30 days"
          : "Older"
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { nav, status, openAgentDialog, openSquadDialog, openPalette } = useWorkspace()
  const pathname = usePathname()
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()

  const recent = nav.threads.slice(0, 40)
  // Threads arrive newest first, so each date bucket is one consecutive run
  const groups: { label: string; threads: typeof recent }[] = []
  for (const thread of recent) {
    const label = bucket(thread.activeAt)
    if (groups.at(-1)?.label === label) groups.at(-1)!.threads.push(thread)
    else groups.push({ label, threads: [thread] })
  }
  const navLink = (href: string) =>
    cn(
      "flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors max-md:h-11 max-md:text-[14px]",
      pathname === href
        ? "bg-accent font-medium text-foreground"
        : "text-foreground/80 hover:bg-accent/60 hover:text-foreground"
    )
  const ownerOf = (thread: (typeof nav.threads)[number]) =>
    thread.agentId
      ? nav.agents.find((agent) => agent.id === thread.agentId)
      : nav.squads.find((squad) => squad.id === thread.squadId)

  return (
    <aside className="flex h-full w-full min-w-0 flex-col">
      <div className="hairline-b flex h-14 shrink-0 items-center gap-2 px-4">
        <Link
          href="/home"
          onClick={onNavigate}
          className="flex items-center gap-2 max-md:min-h-11"
        >
          <LogoMark className="size-7" />
          <Wordmark />
        </Link>
        <Link
          href="/account#plan"
          onClick={onNavigate}
          title="Your plan"
          className="relative ml-auto rounded-sm border px-1.5 py-px font-mono text-[10px] text-muted-foreground transition-colors after:absolute after:-inset-3 after:content-[''] hover:border-rigel/40 hover:text-rigel"
        >
          {status.plan.name}
        </Link>
        {/* In the phone drawer: an explicit way out besides the backdrop */}
        {onNavigate && (
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Close navigation"
            className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          >
            <XIcon className="size-5" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 px-3 pt-3">
        <Link
          href="/home"
          onClick={onNavigate}
          className="btn-liquid flex h-10 w-full items-center justify-center gap-2 text-[13.5px] max-md:h-11"
        >
          <SquarePenIcon className="size-4" />
          New task
        </Link>
        <button
          type="button"
          onClick={openPalette}
          className="flex h-10 w-full items-center gap-2 rounded-xl border bg-background/50 px-3 text-[13px] text-muted-foreground transition-colors hover:border-input hover:text-foreground max-md:h-11"
        >
          <SearchIcon className="size-3.5" />
          Jump to…
          <Kbd className="ml-auto font-mono text-[10px]">⌘K</Kbd>
        </button>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-px px-2 pt-3">
        <Link href="/home" onClick={onNavigate} className={navLink("/home")}>
          <HouseIcon className="size-4" />
          Home
        </Link>
        <Link href="/agents" onClick={onNavigate} className={navLink("/agents")}>
          <UsersIcon className="size-4" />
          Agents
        </Link>
        <Link href="/tasks" onClick={onNavigate} className={navLink("/tasks")}>
          <ListChecksIcon className="size-4" />
          Tasks
          {status.running.length > 0 && (
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px] text-rigel">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-rigel text-rigel" />
              {status.running.length}
            </span>
          )}
        </Link>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Section
          label="Agents"
          count={nav.agents.length}
          onAdd={() => openAgentDialog()}
          addLabel="New agent"
        >
          {nav.agents.length === 0 ? (
            <button
              type="button"
              onClick={() => openAgentDialog()}
              className="mx-0 flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:border-input hover:text-foreground"
            >
              <PlusIcon className="size-3.5" />
              Create your first agent
            </button>
          ) : (
            nav.agents.map((agent) => (
              <Item
                key={agent.id}
                href={
                  agent.latestThreadId
                    ? `/a/${agent.id}/${agent.latestThreadId}`
                    : `/a/${agent.id}`
                }
                active={pathname.startsWith(`/a/${agent.id}`)}
                icon={<Glyph seed={agent.glyph} className="size-[26px]" />}
                title={agent.name}
                subtitle={agent.role}
                busy={agent.busy}
                onNavigate={onNavigate}
              />
            ))
          )}
        </Section>

        <Section
          label="Squads"
          count={nav.squads.length}
          onAdd={() => openSquadDialog()}
          addLabel="New squad"
        >
          {nav.squads.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-faint">
              {nav.agents.length < 2
                ? "Two or more agents can work as a squad."
                : "Group agents so they can work on one request together."}
            </p>
          ) : (
            nav.squads.map((squad) => (
              <Item
                key={squad.id}
                href={
                  squad.latestThreadId
                    ? `/s/${squad.id}/${squad.latestThreadId}`
                    : `/s/${squad.id}`
                }
                active={pathname.startsWith(`/s/${squad.id}`)}
                icon={<SquadGlyph seeds={squad.glyphs} className="size-[26px]" />}
                title={squad.name}
                subtitle={`${squad.agentIds.length} agent${squad.agentIds.length === 1 ? "" : "s"}`}
                busy={squad.busy}
                onNavigate={onNavigate}
              />
            ))
          )}
        </Section>

        {groups.map((group) => (
          <Section key={group.label} label={group.label}>
            {group.threads.map((thread) => {
              const owner = ownerOf(thread)
              const base = thread.agentId
                ? `/a/${thread.agentId}`
                : `/s/${thread.squadId}`
              return (
                <div key={thread.id} className="group/thread relative">
                  <Link
                    href={`${base}/${thread.id}`}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1 pr-7 text-[12.5px] transition-colors max-md:min-h-11 max-md:text-[13.5px]",
                      pathname.endsWith(thread.id)
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "size-1 shrink-0 rounded-full",
                        thread.busy
                          ? "animate-pulse-dot bg-rigel text-rigel"
                          : "bg-faint/60"
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {thread.title ?? "New thread"}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-faint transition-opacity group-hover/thread:opacity-0">
                      {owner && "name" in owner ? owner.name.slice(0, 10) : ""}
                    </span>
                  </Link>
                  <Confirm
                    trigger={
                      <button
                        type="button"
                        aria-label={`Delete thread ${thread.title ?? "New thread"}`}
                        className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-faint opacity-0 transition-opacity group-hover/thread:opacity-100 hover:bg-accent hover:text-destructive focus-visible:opacity-100"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    }
                    title="Delete this thread?"
                    description={`"${thread.title ?? "New thread"}" and its messages are deleted. The agent and its memory stay.`}
                    action="Delete thread"
                    onConfirm={async () => {
                      await deleteThread(thread.id)
                      toast.add({ type: "success", title: "Thread deleted" })
                      if (pathname.endsWith(thread.id)) router.push(base)
                    }}
                  />
                </div>
              )
            })}
          </Section>
        ))}
      </div>

      <div className="flex flex-col gap-px border-t p-2">
        {status.owner && (
          <Link
            href="/owner"
            onClick={onNavigate}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors max-md:h-11",
              pathname.startsWith("/owner")
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            )}
          >
            <ShieldIcon className="size-4" />
            Owner console
          </Link>
        )}
        <Link
          href="/usage"
          onClick={onNavigate}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors max-md:h-11",
            pathname === "/usage"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          )}
        >
          <ActivityIcon className="size-4" />
          Usage
        </Link>
        <div className="flex items-center gap-1">
          <Link
            href="/account"
            onClick={onNavigate}
            className={cn(
              "flex h-8 flex-1 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors max-md:h-11",
              pathname === "/account"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            )}
          >
            <SettingsIcon className="size-4" />
            Account
            {status.usage.warn && (
              <span
                title="Close to your plan's limit"
                className="ml-auto size-1.5 rounded-full bg-betelgeuse"
              />
            )}
          </Link>
          <Tooltip>
            <TooltipTrigger
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
              className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground max-md:size-11"
            >
              <SunIcon className="hidden size-4 dark:block" />
              <MoonIcon className="size-4 dark:hidden" />
            </TooltipTrigger>
            <TooltipContent side="top">Toggle theme</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  )
}
