"use client"

import { PlusIcon, SlidersHorizontalIcon, UsersIcon } from "lucide-react"

import { agentTemplates, useWorkspace } from "@/components/workspace/context"
import { Glyph } from "@/components/glyph"
import type { NavAgent, NavSquad } from "@/queries/workspace"

export function NewAgentCard() {
  const { openAgentDialog } = useWorkspace()
  return (
    <button
      type="button"
      onClick={() => openAgentDialog()}
      className="group flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground transition-colors hover:border-input hover:bg-surface/60 hover:text-foreground"
    >
      <span className="grid size-8 place-items-center rounded-lg border bg-background transition-transform group-hover:scale-105">
        <PlusIcon className="size-4" />
      </span>
      <span className="text-[13px] font-medium">New agent</span>
    </button>
  )
}

export function NewSquadButton({ disabled }: { disabled?: boolean }) {
  const { openSquadDialog } = useWorkspace()
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => openSquadDialog()}
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-input hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <UsersIcon className="size-3.5" />
      New squad
    </button>
  )
}

// Seeds chosen so each template gets a distinct mark that fits its role
const templateSeeds = ["vidya-18", "arjun-86", "meera-36", "kabir-241", "tara-24"]

export function TemplateGrid() {
  const { nav, openAgentDialog } = useWorkspace()
  // Templates already turned into an agent aren't offered again
  const unused = agentTemplates.filter(
    (template) => !nav.agents.some((agent) => agent.name === template.name)
  )
  if (unused.length === 0) return null
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {unused.map((template) => (
        <button
          key={template.name}
          type="button"
          onClick={() => openAgentDialog({ template })}
          className="glass lift group flex flex-col gap-3 rounded-[22px] p-4 text-left"
        >
          <div className="flex items-center gap-3">
            <Glyph
              seed={templateSeeds[agentTemplates.indexOf(template)]}
              className="size-11 rounded-[30%]"
            />
            <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
              <span className="text-[15px] font-semibold tracking-tight">
                {template.name}
              </span>
              <span className="truncate font-mono text-[12px] text-muted-foreground">
                {template.role}
              </span>
            </div>
          </div>
          <p className="line-clamp-3 text-[12.5px] leading-relaxed text-muted-foreground">
            {template.instructions}
          </p>
          <span className="mt-auto inline-flex items-center gap-1 font-mono text-[12px] font-medium text-rigel">
            Create
            <span className="transition-transform duration-300 ease-[var(--ease-out)] group-hover:translate-x-1">
              →
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

// Sits over an agent or squad card (not inside its link) to open its settings
export function EditButton({ agent, squad }: { agent?: NavAgent; squad?: NavSquad }) {
  const { openAgentDialog, openSquadDialog } = useWorkspace()
  return (
    <button
      type="button"
      aria-label={`Configure ${agent?.name ?? squad?.name}`}
      onClick={() => (agent ? openAgentDialog({ agent }) : openSquadDialog({ squad }))}
      className="absolute top-3 right-3 grid size-11 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:size-9"
    >
      <SlidersHorizontalIcon className="size-4" />
    </button>
  )
}
