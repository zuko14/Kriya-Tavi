import type { FlowEdge, FlowGraph, FlowNode } from "./graph"
import { PORTS } from "./graph"

// Where everything goes (SD-15). ELK's layered algorithm handles crossing
// minimisation, ports and loop regions. Nodes have one fixed size, so layout
// needs no DOM measuring and the same graph always gives the same picture.

export const NODE_W = 248
export const NODE_H = 76
export const GRID = 8
// A loop region's frame: the header, and the space around its body
export const REGION_TOP = 56
export const REGION_PAD = 32
const REGION_MIN_W = NODE_W + REGION_PAD * 2
const REGION_MIN_H = NODE_H + REGION_TOP + REGION_PAD

export type Point = { x: number; y: number }
export type Layout = {
  at: Record<string, Point>
  // Bend points per edge id, in flow coordinates
  routes: Record<string, Point[]>
}

/**
 * Where a port sits on a card's bottom edge, from the left. The good path
 * leaves from the centre, so a chain runs straight down; the other way out
 * sits to the right.
 */
export const portX = (type: FlowNode["type"], port: string, width = NODE_W) =>
  Math.round(PORTS[type].indexOf(port) === 0 ? width / 2 : (width * 5) / 6)

/** A loop region's size, from what's in it */
export function regionSize(graph: FlowGraph, id: string): { w: number; h: number } {
  let w = REGION_MIN_W
  let h = REGION_MIN_H
  for (const node of graph.nodes) {
    if (node.parent !== id) continue
    const size =
      node.type === "loop" ? regionSize(graph, node.id) : { w: NODE_W, h: NODE_H }
    w = Math.max(w, node.at.x + size.w + REGION_PAD)
    h = Math.max(h, node.at.y + size.h + REGION_PAD)
  }
  return { w, h }
}

type ElkNode = {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  children?: ElkNode[]
  edges?: ElkEdge[]
  ports?: { id: string; x?: number; y?: number; layoutOptions?: Record<string, string> }[]
  layoutOptions?: Record<string, string>
}
type ElkEdge = {
  id: string
  sources: string[]
  targets: string[]
  sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[]
}

const OPTIONS = {
  "elk.algorithm": "layered",
  // Top to bottom: flows are mostly chains, and the column between the
  // sidebar and the inspector is tall, so cards stay readable at full size
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "48",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "16",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.json.edgeCoords": "ROOT",
  "elk.json.shapeCoords": "PARENT",
}

const portId = (node: string, port: string) => `${node}.${port}`

/**
 * The polyline from a handle through a route's bends to a handle. A region's
 * ports aren't where ELK put them (its handles sit by its measured width), so
 * the ends join the first and last bend at right angles: every wire stays
 * orthogonal, and it still goes round what ELK routed it round.
 */
export function wirePoints(source: Point, route: Point[], target: Point) {
  if (route.length === 0) return null
  const first = route[0]
  const last = route.at(-1)!
  const points = [
    source,
    { x: source.x, y: first.y },
    ...route,
    { x: target.x, y: last.y },
    target,
  ].filter((p, i, all) => i === 0 || p.x !== all[i - 1].x || p.y !== all[i - 1].y)
  // Then the middle of straight runs; a corner always survives
  return points.filter((p, i) => {
    const a = points[i - 1]
    const b = points[i + 1]
    return !a || !b || !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y))
  })
}

function elkNode(graph: FlowGraph, node: FlowNode): ElkNode {
  const outs = PORTS[node.type]
  if (node.type === "loop") {
    return {
      id: node.id,
      layoutOptions: {
        "elk.portConstraints": "FIXED_ORDER",
        "elk.layered.spacing.nodeNodeBetweenLayers": "64",
        "elk.padding": `[top=${REGION_TOP},left=${REGION_PAD},bottom=${REGION_PAD},right=${REGION_PAD}]`,
      },
      ports: [
        { id: portId(node.id, "in"), layoutOptions: { "elk.port.side": "NORTH" } },
        ...outs.map((port) => ({
          id: portId(node.id, port),
          layoutOptions: { "elk.port.side": "SOUTH" },
        })),
      ],
      children: graph.nodes
        .filter((n) => n.parent === node.id)
        .map((n) => elkNode(graph, n)),
    }
  }
  return {
    id: node.id,
    width: NODE_W,
    height: NODE_H,
    layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: [
      { id: portId(node.id, "in"), x: NODE_W / 2, y: 0 },
      ...outs.map((port) => ({
        id: portId(node.id, port),
        x: portX(node.type, port),
        y: NODE_H,
      })),
    ],
  }
}

/** A deterministic left-to-right layout */
export async function layoutGraph(graph: FlowGraph): Promise<Layout> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js")
  const elk = new ELK()
  const edge = (e: FlowEdge): ElkEdge => ({
    id: e.id,
    sources: [portId(e.from, e.port)],
    targets: [portId(e.to, "in")],
  })
  const result = (await elk.layout({
    id: "root",
    layoutOptions: OPTIONS,
    children: graph.nodes.filter((n) => !n.parent).map((n) => elkNode(graph, n)),
    edges: graph.edges.map(edge),
  } as never)) as unknown as ElkNode

  const at: Layout["at"] = {}
  const walk = (node: ElkNode) => {
    for (const child of node.children ?? []) {
      at[child.id] = { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) }
      walk(child)
    }
  }
  walk(result)

  const routes: Layout["routes"] = {}
  const collect = (node: ElkNode) => {
    for (const e of node.edges ?? []) {
      const section = e.sections?.[0]
      if (section) routes[e.id] = section.bendPoints ?? []
    }
    node.children?.forEach(collect)
  }
  collect(result)
  return { at, routes }
}

/**
 * The nearest spot for a new card that covers nothing, for a flow someone
 * placed by hand (which automatic layout leaves alone). Walks down, then
 * across; a flow has at most 60 nodes, so it ends quickly.
 */
export function freeSpot(graph: FlowGraph, want: Point, parent?: string): Point {
  const taken = graph.nodes
    .filter((n) => n.parent === parent)
    .map((n) => {
      const size = n.type === "loop" ? regionSize(graph, n.id) : { w: NODE_W, h: NODE_H }
      return { ...n.at, ...size }
    })
  const clear = (p: Point) =>
    taken.every(
      (t) =>
        p.x + NODE_W + GRID <= t.x ||
        t.x + t.w + GRID <= p.x ||
        p.y + NODE_H + GRID <= t.y ||
        t.y + t.h + GRID <= p.y
    )
  for (let column = 0; ; column++)
    for (let row = 0; row < 12; row++) {
      const spot = {
        x: want.x + column * (NODE_W + 48),
        y: want.y + row * (NODE_H + 32),
      }
      if (clear(spot)) return spot
    }
}

/** The graph with a layout's positions */
export const withLayout = (graph: FlowGraph, layout: Layout): FlowGraph => ({
  ...graph,
  nodes: graph.nodes.map((n) => ({ ...n, at: layout.at[n.id] ?? n.at })),
})

/** Nothing has been placed yet: a template or the copilot's draft */
export const unplaced = (graph: FlowGraph) =>
  graph.nodes.length > 1 &&
  new Set(graph.nodes.map((n) => `${n.parent ?? ""}|${n.at.x}|${n.at.y}`)).size <
    new Set(graph.nodes.map((n) => n.parent ?? "")).size + 1
