"use client"

import * as React from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { TriangleAlertIcon } from "lucide-react"

import {
  ALTERNATE,
  PORT_LABEL,
  RULE_LABEL,
  STATE_LOOK,
  TYPE_LOOK,
  type RunState,
} from "@/components/flows/look"
import type { FlowNode } from "@/lib/flows/graph"
import { PORTS } from "@/lib/flows/graph"
import { NODE_H, NODE_W, portX } from "@/lib/flows/layout"
import { cn } from "@/lib/utils"

export type CardData = {
  node: FlowNode
  // The agent's name, or the region's line
  detail: string
  state?: RunState
  // "Round 2 of 3", a duration
  note?: string
  problem?: string
  reading: boolean
  // Changed in a preview (SD-12)
  mark?: "added" | "changed"
  // Ways out that lead somewhere
  used: string[]
}

const handleClass = (port: string) =>
  port === "error" ? "kflow-err" : ALTERNATE.has(port) ? "kflow-alt" : undefined

function detailOf(node: FlowNode, fallback: string) {
  switch (node.type) {
    case "check": {
      const rule = node.config.rule
      if (rule.kind === "min_chars") return `At least ${rule.n} characters`
      if (rule.kind === "max_chars") return `At most ${rule.n} characters`
      if (rule.kind === "tool_ran") return `${rule.tool} ran ${rule.atLeast}×`
      return `${RULE_LABEL[rule.kind]} ${"text" in rule ? `"${rule.text}"` : rule.n}`
    }
    case "approval":
      return "Waits for you"
    case "merge":
      return "Joins what came before"
    case "step":
      return node.config.doneWhen || "Done when…"
    case "start":
      return node.config.goal || "Your inputs"
    case "end":
      return "What the flow returns"
    default:
      return fallback
  }
}

// Sits just beside its wire, under the card
function PortLabel({ port, x }: { port: string; x: number }) {
  return (
    <span
      style={{ left: x + 8 }}
      className={cn(
        "pointer-events-none absolute top-full mt-1 font-mono text-[9.5px] whitespace-nowrap",
        port === "error"
          ? "text-destructive/80"
          : ALTERNATE.has(port)
            ? "text-betelgeuse"
            : "text-muted-foreground"
      )}
    >
      {PORT_LABEL[port]}
    </span>
  )
}

export const Card = React.memo(function Card({ data, selected }: NodeProps) {
  const { node, detail, state, note, problem, reading, mark, used } = data as CardData
  const look = TYPE_LOOK[node.type]
  const Icon = look.icon
  const run = state ? STATE_LOOK[state] : null
  const RunIcon = run?.icon
  const outs = PORTS[node.type]
  const muted = state === "idle" || state === "skipped"
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      title={problem}
      className={cn(
        "group relative flex items-center gap-3 rounded-[var(--radius-lg)] border bg-surface px-3 transition-[box-shadow,opacity] duration-150",
        "shadow-[0_1px_2px_rgb(19_41_43/0.05)]",
        selected && "border-rigel ring-2 ring-rigel/25",
        run?.ring,
        problem && !run && "border-destructive/60",
        mark === "added" && "border-ok ring-2 ring-ok/25",
        mark === "changed" && "border-betelgeuse ring-2 ring-betelgeuse/25",
        muted && "opacity-60",
        state === "skipped" && "border-dashed"
      )}
    >
      {node.type !== "start" && (
        <Handle id="in" type="target" position={Position.Top} isConnectable={!reading} />
      )}
      <span
        className={cn("grid size-8 shrink-0 place-items-center rounded-md", look.tint)}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="label-mono flex items-center gap-1 !text-[9.5px] !tracking-[0.12em]">
          {look.label}
          {run && RunIcon && state !== "idle" && (
            <span
              className={cn(
                "ml-auto flex items-center gap-1 tracking-normal normal-case",
                run.text
              )}
            >
              <RunIcon
                className={cn(
                  "size-3",
                  state === "running" && "motion-safe:animate-spin"
                )}
                aria-hidden
              />
              {note ?? run.label}
            </span>
          )}
        </span>
        <span className="truncate text-[13px] leading-tight font-medium">
          {node.title}
        </span>
        <span className="truncate text-[11.5px] leading-tight text-muted-foreground">
          {detailOf(node, detail)}
        </span>
      </span>
      {problem && !run && (
        <TriangleAlertIcon
          className="size-3.5 shrink-0 text-destructive"
          aria-label={problem}
        />
      )}
      {outs.map((port) => (
        <React.Fragment key={port}>
          <Handle
            id={port}
            type="source"
            position={Position.Bottom}
            className={cn(
              handleClass(port),
              port === "error" && !used.includes(port) && "kflow-quiet"
            )}
            style={{ left: portX(node.type, port) }}
            isConnectable={!reading}
            aria-label={`${node.title}: ${PORT_LABEL[port] || "next"}`}
          />
          {outs.length > 1 && (port !== "error" || used.includes(port)) && (
            <PortLabel port={port} x={portX(node.type, port)} />
          )}
        </React.Fragment>
      ))}
    </div>
  )
})

export type RegionData = CardData & { width: number; height: number }

export const Region = React.memo(function Region({ data, selected }: NodeProps) {
  const { node, width, height, state, note, problem, reading, detail } =
    data as RegionData
  const look = TYPE_LOOK.loop
  const Icon = look.icon
  const run = state ? STATE_LOOK[state] : null
  return (
    <div
      style={{ width, height }}
      title={problem}
      className={cn(
        "relative rounded-[var(--radius-xl)] border border-dashed border-rigel/40 bg-rigel-soft/40",
        selected && "border-solid border-rigel ring-2 ring-rigel/25",
        run?.ring,
        problem && !run && "border-destructive/60"
      )}
    >
      <Handle id="in" type="target" position={Position.Top} isConnectable={!reading} />
      <div className="flex h-14 items-center gap-2.5 px-4">
        <span
          className={cn("grid size-7 shrink-0 place-items-center rounded-md", look.tint)}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-medium">{node.title}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {note ?? detail}
          </span>
        </span>
      </div>
      {PORTS.loop.map((port) => (
        <React.Fragment key={port}>
          <Handle
            id={port}
            type="source"
            position={Position.Bottom}
            className={handleClass(port)}
            style={{ left: portX("loop", port, width) }}
            isConnectable={!reading}
            aria-label={`${node.title}: ${PORT_LABEL[port]}`}
          />
          <PortLabel port={port} x={portX("loop", port, width)} />
        </React.Fragment>
      ))}
    </div>
  )
})
