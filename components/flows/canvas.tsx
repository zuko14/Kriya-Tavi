"use client"

import "@xyflow/react/dist/base.css"
import "@/components/flows/canvas.css"

import * as React from "react"
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react"
import { LocateFixedIcon, MinusIcon, PlusIcon, WandIcon } from "lucide-react"

import { DataLink, Routed, type EdgeData } from "@/components/flows/edges"
import type { RunState } from "@/components/flows/look"
import { Card, Region, type CardData, type RegionData } from "@/components/flows/nodes"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Issue } from "@/lib/flows/compile"
import { refsIn, templatesOf, type FlowGraph, type FlowNode } from "@/lib/flows/graph"
import { GRID, NODE_H, NODE_W, regionSize, type Layout } from "@/lib/flows/layout"
import { cn } from "@/lib/utils"

// The left side keeps clear of the zoom controls
const FIT_PADDING = { top: "24px", right: "32px", bottom: "32px", left: "72px" } as const
const MAP_FROM = 12
// Below this a card can't be read; a long flow pans instead
const FIT_MIN = 0.55
const NODE_TYPES = { card: Card, region: Region }
const EDGE_TYPES = { routed: Routed, data: DataLink }

export type NodeRunView = { state: RunState; note?: string }

export type CanvasProps = {
  graph: FlowGraph
  agentName: (id: string) => string
  issues?: Issue[]
  routes?: Layout["routes"]
  reading?: boolean
  // Run view: each node's state; edges follow from the ports taken
  states?: Record<string, NodeRunView>
  taken?: Set<string>
  dead?: Set<string>
  live?: Set<string>
  // Preview of a proposal
  added?: Set<string>
  changed?: Set<string>
  selected?: string | null
  onSelect?: (id: string | null) => void
  onMove?: (id: string, at: { x: number; y: number }) => void
  onConnect?: (connection: Connection) => void
  onDelete?: (nodes: string[], edges: string[]) => void
  onTidy?: () => void
  // A small preview may zoom further out than the editor
  fitMin?: number
}

const depth = (graph: FlowGraph, node: FlowNode) => {
  let d = 0
  for (let at = node.parent; at; at = graph.nodes.find((n) => n.id === at)?.parent) d++
  return d
}

const regionLine = (graph: FlowGraph, node: Extract<FlowNode, { type: "loop" }>) => {
  const until = graph.nodes.find((n) => n.id === node.config.until)
  const rounds = `Up to ${node.config.maxIterations} ${node.config.maxIterations === 1 ? "round" : "rounds"}`
  return until ? `${rounds} · until ${until.title} passes` : rounds
}

function toNodes(p: CanvasProps): Node[] {
  const {
    graph,
    agentName,
    issues = [],
    states,
    reading = false,
    added,
    changed,
    selected,
  } = p
  return [...graph.nodes]
    .sort((a, b) => depth(graph, a) - depth(graph, b))
    .map((node) => {
      const problem = issues.find(
        (i) => i.node === node.id && i.severity === "error"
      )?.message
      const run = states?.[node.id]
      const base: CardData = {
        node,
        detail: node.type === "agent" ? agentName(node.config.agentId) : "",
        state: states ? (run?.state ?? "idle") : undefined,
        note: run?.note,
        problem,
        reading,
        mark: added?.has(node.id)
          ? "added"
          : changed?.has(node.id)
            ? "changed"
            : undefined,
        used: graph.edges.filter((e) => e.from === node.id).map((e) => e.port),
      }
      const common = {
        id: node.id,
        position: node.at,
        selected: node.id === selected,
        deletable: !reading && node.type !== "start",
        draggable: !reading,
        ariaLabel: `${node.title}${run ? `, ${run.state}` : ""}`,
        ...(node.parent && { parentId: node.parent }),
      }
      if (node.type === "loop") {
        const size = regionSize(graph, node.id)
        const data: RegionData = {
          ...base,
          detail: regionLine(graph, node),
          width: size.w,
          height: size.h,
        }
        return {
          ...common,
          type: "region",
          data,
          width: size.w,
          height: size.h,
          // Behind its own body
          zIndex: depth(graph, node),
        }
      }
      return {
        ...common,
        type: "card",
        data: base,
        width: NODE_W,
        height: NODE_H,
        zIndex: depth(graph, node) + 2,
      }
    })
}

function toEdges(p: CanvasProps): Edge[] {
  const { graph, routes, taken, dead, live, added, selected, reading = false } = p
  const edges: Edge[] = graph.edges.map((e) => {
    const data: EdgeData = {
      port: e.port,
      route: routes?.[e.id],
      run: taken?.has(e.id)
        ? "taken"
        : dead?.has(e.id)
          ? "dead"
          : live?.has(e.id)
            ? "live"
            : undefined,
      mark: added?.has(e.id) ? "added" : undefined,
    }
    return {
      id: e.id,
      source: e.from,
      sourceHandle: e.port,
      target: e.to,
      targetHandle: "in",
      type: "routed",
      data,
      deletable: !reading,
      zIndex: 1,
      ariaLabel: `From ${e.from} to ${e.to}`,
    }
  })
  // What the selected node reads, as a quiet overlay
  const node = graph.nodes.find((n) => n.id === selected)
  if (node)
    for (const root of new Set(
      templatesOf(node).flatMap((t) => refsIn(t).map((r) => r.root))
    )) {
      const from = graph.nodes.find((n) => n.id === root)
      if (!from || from.type === "end") continue
      edges.push({
        id: `data:${root}:${node.id}`,
        source: root,
        sourceHandle:
          from.type === "check" ? "pass" : from.type === "loop" ? "done" : "out",
        target: node.id,
        targetHandle: "in",
        type: "data",
        selectable: false,
        focusable: false,
        deletable: false,
        zIndex: 1,
      })
    }
  return edges
}

function Controls({ onTidy }: { onTidy?: () => void }) {
  const flow = useReactFlow()
  const button =
    "grid size-9 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
  const item = (label: string, icon: React.ReactNode, run: () => void) => (
    <Tooltip>
      <TooltipTrigger aria-label={label} onClick={run} className={button}>
        {icon}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
  return (
    <div className="absolute bottom-4 left-4 z-10 flex flex-col divide-y overflow-hidden rounded-lg border bg-surface shadow-sm">
      {item("Zoom in", <PlusIcon className="size-4" />, () => void flow.zoomIn())}
      {item("Zoom out", <MinusIcon className="size-4" />, () => void flow.zoomOut())}
      {item(
        "Fit to view",
        <LocateFixedIcon className="size-4" />,
        () => void flow.fitView({ padding: FIT_PADDING, maxZoom: 1, minZoom: FIT_MIN })
      )}
      {onTidy && item("Tidy the layout", <WandIcon className="size-4" />, onTidy)}
    </div>
  )
}

function Inner(p: CanvasProps) {
  const {
    reading = false,
    onSelect,
    onMove,
    onConnect,
    onDelete,
    onTidy,
    fitMin = FIT_MIN,
  } = p
  const { graph, agentName, issues, states, selected, added, changed } = p
  const { routes, taken, dead, live } = p
  const wanted = React.useMemo(
    () =>
      toNodes({ graph, agentName, issues, states, selected, added, changed, reading }),
    [graph, agentName, issues, states, selected, added, changed, reading]
  )
  const edges = React.useMemo(
    () =>
      toEdges({
        graph,
        agentName,
        routes,
        taken,
        dead,
        live,
        added,
        selected,
        reading,
      }),
    [graph, agentName, routes, taken, dead, live, added, selected, reading]
  )
  // Dragging moves local copies; a new graph from the page replaces them
  const [nodes, setNodes] = React.useState(wanted)
  const [seen, setSeen] = React.useState(wanted)
  if (seen !== wanted) {
    setSeen(wanted)
    setNodes(wanted)
  }
  const flow = useReactFlow()
  const size = p.graph.nodes.length
  React.useEffect(() => {
    void flow.fitView({ padding: FIT_PADDING, maxZoom: 1, minZoom: fitMin })
  }, [flow, size, fitMin])

  const onNodesChange = React.useCallback((changes: NodeChange[]) => {
    // Selection is the page's; everything else stays local until a drop
    setNodes((now) =>
      applyNodeChanges(
        changes.filter((c) => c.type !== "select" && c.type !== "remove"),
        now
      )
    )
  }, [])

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches

  return (
    <div className={cn("kflow relative", reading && "is-reading")}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onSelect?.(node.id)}
        onPaneClick={() => onSelect?.(null)}
        onNodeDragStop={(_, node) =>
          onMove?.(node.id, {
            x: Math.round(node.position.x / GRID) * GRID,
            y: Math.round(node.position.y / GRID) * GRID,
          })
        }
        onConnect={onConnect}
        onBeforeDelete={async ({ nodes: gone, edges: cut }) => {
          onDelete?.(
            gone.map((n) => n.id),
            cut.filter((e) => e.type === "routed").map((e) => e.id)
          )
          return false
        }}
        nodesDraggable={!reading}
        nodesConnectable={!reading}
        elementsSelectable
        snapToGrid
        snapGrid={[GRID, GRID]}
        minZoom={0.25}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: FIT_PADDING, maxZoom: 1, minZoom: fitMin }}
        proOptions={{ hideAttribution: false }}
        deleteKeyCode={reading ? null : ["Backspace", "Delete"]}
        connectionRadius={28}
        ariaLabelConfig={{
          "node.a11yDescription.default":
            "Press Enter to open it, arrow keys to move it.",
          "edge.a11yDescription.default": "A connection between two steps.",
        }}
        autoPanOnNodeFocus={!reduced}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1.5}
          color="var(--grid-dot)"
        />
        {/* Only once a flow outgrows the view: a small one needs no map */}
        {p.graph.nodes.length > MAP_FROM && (
          <MiniMap
            pannable
            zoomable
            style={{ width: 132, height: 96 }}
            maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
            nodeColor={(n) =>
              n.type === "region" ? "var(--rigel-soft)" : "var(--muted-foreground)"
            }
            nodeStrokeWidth={0}
            ariaLabel="Map of this flow"
          />
        )}
      </ReactFlow>
      <Controls onTidy={reading ? undefined : onTidy} />
    </div>
  )
}

export default function FlowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  )
}
