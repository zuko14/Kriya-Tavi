"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckIcon, ChevronDownIcon, PlusIcon, UsersIcon } from "lucide-react"

import { createThread } from "@/actions/threads"
import { Glyph, SquadGlyph } from "@/components/glyph"
import { Composer } from "@/components/thread/composer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/components/ui/toast"
import { useWorkspace } from "@/components/workspace/context"

type Target = { kind: "agent" | "squad"; id: string }

const TARGET_KEY = "kriya:ask-target"

// The home screen's composer: pick who does it, say what, and land in a new
// thread with the task already running
export function Ask() {
  const router = useRouter()
  const { nav, status, openAgentDialog, openSquadDialog } = useWorkspace()
  const [target, setTarget] = React.useState<Target | null>(null)
  const [starting, setStarting] = React.useState(false)

  // The last pick is a per-device convenience; fall back to the first agent
  React.useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(TARGET_KEY) ?? "null"
      ) as Target | null
      const exists =
        saved &&
        (saved.kind === "agent"
          ? nav.agents.some((a) => a.id === saved.id)
          : nav.squads.some((s) => s.id === saved.id))
      // Restoring from browser storage is exactly what effects are for
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (exists) setTarget(saved)
    } catch {}
  }, [nav.agents, nav.squads])

  const pick = (next: Target) => {
    setTarget(next)
    try {
      localStorage.setItem(TARGET_KEY, JSON.stringify(next))
    } catch {}
  }

  const current: Target | null =
    target ?? (nav.agents[0] ? { kind: "agent", id: nav.agents[0].id } : null)
  const agent =
    current?.kind === "agent" ? nav.agents.find((a) => a.id === current.id) : undefined
  const squad =
    current?.kind === "squad" ? nav.squads.find((s) => s.id === current.id) : undefined
  const name = agent?.name ?? squad?.name

  const start = async (text: string) => {
    if (!current || starting) return
    setStarting(true)
    try {
      const owner =
        current.kind === "agent" ? { agentId: current.id } : { squadId: current.id }
      const id = await createThread(owner)
      // The thread page picks this up and sends it (see ThreadView)
      try {
        sessionStorage.setItem(`kriya:pending:${id}`, text)
      } catch {}
      router.push(`/${current.kind === "agent" ? "a" : "s"}/${current.id}/${id}`)
    } catch {
      setStarting(false)
      toast.add({ type: "error", title: "Couldn't start the thread. Try again." })
    }
  }

  const suggestions = [
    status.web && "Compare the best phones under ₹30,000 right now, with sources",
    "Plan my week: three priorities a day, with time for breaks",
    "Draft a polite payment reminder for an invoice 30 days late",
    status.web && "What changed in Indian income tax rules this year?",
    "Explain compound interest with a ₹10,000 example",
    squad && "Split a product launch plan across the squad",
  ].filter((value): value is string => !!value)

  const picker = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Choose who does this"
        className="flex h-11 max-w-[55vw] min-w-0 items-center gap-1.5 rounded-full border bg-background/60 pr-2.5 pl-1.5 text-[13px] font-medium transition-colors hover:bg-accent sm:h-8 sm:max-w-64"
      >
        {agent ? (
          <Glyph seed={agent.glyph} className="size-6 rounded-full" />
        ) : squad ? (
          <SquadGlyph seeds={squad.glyphs} className="size-6" />
        ) : null}
        <span className="truncate">{name}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60svh] w-72 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="label-mono">Agents</DropdownMenuLabel>
          {nav.agents.map((a) => (
            <DropdownMenuItem
              key={a.id}
              onClick={() => pick({ kind: "agent", id: a.id })}
              className="min-h-11"
            >
              <Glyph seed={a.glyph} className="size-7" />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate">{a.name}</span>
                <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                  {a.busy ? "working now" : a.role}
                </span>
              </span>
              {agent?.id === a.id && <CheckIcon className="text-rigel" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {nav.squads.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="label-mono">Squads</DropdownMenuLabel>
            {nav.squads.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onClick={() => pick({ kind: "squad", id: s.id })}
                className="min-h-11"
              >
                <SquadGlyph seeds={s.glyphs} className="size-7" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate">{s.name}</span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    lead + {s.agentIds.length - 1} sub-agent
                    {s.agentIds.length === 2 ? "" : "s"}
                  </span>
                </span>
                {squad?.id === s.id && <CheckIcon className="text-rigel" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openAgentDialog()} className="min-h-11">
          <PlusIcon />
          New agent
        </DropdownMenuItem>
        {nav.agents.length >= 2 && (
          <DropdownMenuItem onClick={() => openSquadDialog()} className="min-h-11">
            <UsersIcon />
            New squad
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const blocked = status.usage.blocked

  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-4 sm:-mx-6">
        <Composer
          draftKey="home"
          placeholder={name ? `Give ${name} a task…` : "Give a task…"}
          busy={false}
          disabled={!!blocked || !current || starting}
          onSend={start}
          onStop={() => {}}
          tier={agent?.model ?? null}
          leading={picker}
          autoFocus={false}
        />
      </div>
      {blocked ? (
        <p className="rounded-2xl border border-betelgeuse/40 bg-betelgeuse-soft px-4 py-3 text-[13px]">
          {blocked}{" "}
          <Link href="/account#plan" className="font-medium text-rigel hover:underline">
            See plans →
          </Link>
        </p>
      ) : (
        <div
          aria-label="Suggestions"
          className="-mx-4 flex snap-x [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
        >
          {suggestions.slice(0, 5).map((text) => (
            <button
              key={text}
              type="button"
              disabled={starting}
              onClick={() => start(text)}
              className="min-h-11 shrink-0 snap-start rounded-full border bg-surface/60 px-4 text-left text-[13px] text-muted-foreground transition-colors hover:border-input hover:text-foreground disabled:opacity-50 sm:min-h-9"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
