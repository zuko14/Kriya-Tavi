"use client"

import { STATE_LOOK, TYPE_LOOK, type RunState } from "@/components/flows/look"
import type { FlowGraph } from "@/lib/flows/graph"
import { cn } from "@/lib/utils"

// The same flow as a list: the phone's view and the screen reader's path
// (UX_AND_INTERACTION_SPEC §6)
export function Outline({
  graph,
  states,
  selected,
  onSelect,
  agentName,
}: {
  graph: FlowGraph
  states?: Record<string, { state: RunState; note?: string }>
  selected?: string | null
  onSelect?: (id: string) => void
  agentName: (id: string) => string
}) {
  const walk = (parent?: string): React.ReactNode => {
    const nodes = graph.nodes.filter((n) => n.parent === parent)
    if (nodes.length === 0) return null
    return (
      <ol className={cn("flex flex-col gap-1.5", parent && "mt-1.5 ml-4 border-l pl-3")}>
        {nodes.map((node) => {
          const look = TYPE_LOOK[node.type]
          const Icon = look.icon
          const run = states?.[node.id]
          const state = run ? STATE_LOOK[run.state] : null
          const StateIcon = state?.icon
          return (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => onSelect?.(node.id)}
                aria-current={selected === node.id ? "true" : undefined}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 rounded-lg border bg-surface px-3 py-2 text-left",
                  selected === node.id && "border-rigel"
                )}
              >
                <span
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-md",
                    look.tint
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[13.5px] font-medium">{node.title}</span>
                  <span className="truncate text-[11.5px] text-muted-foreground">
                    {node.type === "agent" ? agentName(node.config.agentId) : look.label}
                  </span>
                </span>
                {state && StateIcon && run && (
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 text-[11.5px]",
                      state.text
                    )}
                  >
                    <StateIcon className="size-3.5" aria-hidden />
                    {run.note ?? state.label}
                  </span>
                )}
              </button>
              {node.type === "loop" && walk(node.id)}
            </li>
          )
        })}
      </ol>
    )
  }
  return <nav aria-label="Steps in order">{walk(undefined)}</nav>
}
