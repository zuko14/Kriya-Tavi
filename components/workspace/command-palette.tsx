"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  ActivityIcon,
  HomeIcon,
  ListChecksIcon,
  MessageSquareIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react"
import { useTheme } from "next-themes"

import { Glyph, SquadGlyph } from "@/components/glyph"
import { useWorkspace } from "@/components/workspace/context"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"

export function CommandPalette() {
  const router = useRouter()
  const { nav, dialog, openPalette, closeDialog, openAgentDialog, openSquadDialog } =
    useWorkspace()
  const { resolvedTheme, setTheme } = useTheme()
  const open = dialog?.kind === "palette"

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (open) closeDialog()
        else openPalette()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, openPalette, closeDialog])

  const go = (href: string) => {
    closeDialog()
    router.push(href)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => (next ? openPalette() : closeDialog())}
      title="Jump to"
      description="Agents, squads, threads and actions"
      className="sm:max-w-lg"
    >
      <Command>
        <CommandInput placeholder="Type an agent, squad, thread or action…" />
        <CommandList className="max-h-96">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {nav.agents.length > 0 && (
            <CommandGroup heading="Agents">
              {nav.agents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={`agent ${agent.name} ${agent.role}`}
                  onSelect={() =>
                    go(
                      agent.latestThreadId
                        ? `/a/${agent.id}/${agent.latestThreadId}`
                        : `/a/${agent.id}`
                    )
                  }
                >
                  <Glyph seed={agent.glyph} className="size-5" />
                  <span className="truncate">{agent.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {agent.role}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {nav.squads.length > 0 && (
            <CommandGroup heading="Squads">
              {nav.squads.map((squad) => (
                <CommandItem
                  key={squad.id}
                  value={`squad ${squad.name}`}
                  onSelect={() =>
                    go(
                      squad.latestThreadId
                        ? `/s/${squad.id}/${squad.latestThreadId}`
                        : `/s/${squad.id}`
                    )
                  }
                >
                  <SquadGlyph seeds={squad.glyphs} className="size-5" />
                  {squad.name}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {nav.threads.length > 0 && (
            <CommandGroup heading="Threads">
              {nav.threads.slice(0, 20).map((thread) => (
                <CommandItem
                  key={thread.id}
                  value={`thread ${thread.title ?? ""} ${thread.preview ?? ""} ${thread.id}`}
                  onSelect={() =>
                    go(
                      thread.agentId
                        ? `/a/${thread.agentId}/${thread.id}`
                        : `/s/${thread.squadId}/${thread.id}`
                    )
                  }
                >
                  <MessageSquareIcon className="text-muted-foreground" />
                  <span className="truncate">{thread.title ?? "New thread"}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Actions">
            <CommandItem value="new agent create" onSelect={() => openAgentDialog()}>
              <PlusIcon />
              New agent
            </CommandItem>
            <CommandItem
              value="new squad create group"
              onSelect={() => openSquadDialog()}
            >
              <UsersIcon />
              New squad
            </CommandItem>
            <CommandItem value="home new task ask" onSelect={() => go("/home")}>
              <HomeIcon />
              Home
            </CommandItem>
            <CommandItem value="agents team squads manage" onSelect={() => go("/agents")}>
              <UsersIcon />
              Agents
            </CommandItem>
            <CommandItem
              value="tasks running queue history"
              onSelect={() => go("/tasks")}
            >
              <ListChecksIcon />
              Tasks
            </CommandItem>
            <CommandItem value="usage cost rupees spend" onSelect={() => go("/usage")}>
              <ActivityIcon />
              Usage
            </CommandItem>
            <CommandItem
              value="account plan billing profile password"
              onSelect={() => go("/account")}
            >
              <SettingsIcon />
              Account
            </CommandItem>
            <CommandItem
              value="toggle theme dark light"
              onSelect={() => {
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
                closeDialog()
              }}
            >
              <MoonIcon />
              Toggle theme
              <CommandShortcut>
                {resolvedTheme === "dark" ? "light" : "dark"}
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
