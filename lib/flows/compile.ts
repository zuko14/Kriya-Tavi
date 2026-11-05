import {
  FlowGraph,
  type FlowEdge,
  type FlowNode,
  LIMITS,
  PORTS,
  refsIn,
  templatesOf,
} from "./graph"

// Validates a graph and turns it into the plan the engine walks
// (ARCHITECTURE §4, SD-05). The top level and every loop body are DAGs: the
// only repetition is a loop region, so termination and the worst case follow
// from the shape. Pure, so the editor shows the server's verdict as you draw.

export type Issue = {
  severity: "error" | "warning"
  node?: string
  message: string
}

export type Plan = {
  nodes: Record<string, FlowNode>
  // Each scope's nodes in topological order; "" is the top level
  children: Record<string, string[]>
  incoming: Record<string, FlowEdge[]>
  outgoing: Record<string, FlowEdge[]>
  inputs: FlowGraph["inputs"]
}

export const DEFAULT_MAX_AGENT_RUNS = 40

export type Bound = {
  // Exact worst case of model-driven runs (SD-05's W)
  agentRuns: number
  gates: number
}

export type Compiled = { issues: Issue[]; bound: Bound; plan: Plan | null }

const scopeOf = (node: FlowNode) => node.parent ?? ""

function topological(ids: string[], edges: FlowEdge[]) {
  const degree = new Map(ids.map((id) => [id, 0]))
  for (const e of edges) degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  // Input order breaks ties, so the same graph always gives the same order
  const ready = ids.filter((id) => degree.get(id) === 0)
  const out: string[] = []
  while (ready.length) {
    const id = ready.shift()!
    out.push(id)
    for (const e of edges.filter((x) => x.from === id)) {
      const left = degree.get(e.to)! - 1
      degree.set(e.to, left)
      if (left === 0) ready.push(e.to)
    }
  }
  return out.length === ids.length ? out : null
}

function depthOf(node: FlowNode, byId: Map<string, FlowNode>) {
  let depth = 0
  const seen = new Set<string>()
  for (let at = node.parent; at; at = byId.get(at)?.parent) {
    if (seen.has(at)) return Infinity
    seen.add(at)
    depth++
  }
  return depth
}

/** Every node that runs before `id`, including what comes before its enclosing loops */
export function before(plan: Plan, id: string) {
  const seen = new Set<string>()
  const walk = (at: string) => {
    for (const e of plan.incoming[at] ?? [])
      if (!seen.has(e.from)) {
        seen.add(e.from)
        walk(e.from)
      }
  }
  for (let at: string | undefined = id; at; at = plan.nodes[at]?.parent) walk(at)
  return seen
}

/** Top-level nodes after `id` (the ones a re-run must run again) */
export function after(plan: Plan, id: string) {
  const seen = new Set<string>()
  const walk = (at: string) => {
    for (const e of plan.outgoing[at] ?? [])
      if (!seen.has(e.to)) {
        seen.add(e.to)
        walk(e.to)
      }
  }
  walk(id)
  return seen
}

/** The top-level node that holds `id`: itself, or its outermost loop */
export function topOf(plan: Plan, id: string) {
  let at = id
  while (plan.nodes[at]?.parent) at = plan.nodes[at].parent!
  return at
}

export function compile(
  input: unknown,
  { maxAgentRuns = DEFAULT_MAX_AGENT_RUNS }: { maxAgentRuns?: number } = {}
): Compiled {
  const bound: Bound = { agentRuns: 0, gates: 0 }
  const parsed = FlowGraph.safeParse(input)
  if (!parsed.success)
    return {
      bound,
      plan: null,
      issues: [
        {
          severity: "error",
          message: `This flow isn't valid: ${parsed.error.issues[0]?.path.join(".") || "shape"}: ${parsed.error.issues[0]?.message}`,
        },
      ],
    }
  const graph = parsed.data
  const issues: Issue[] = []
  const error = (message: string, node?: string) =>
    issues.push({ severity: "error", message, node })
  const warn = (message: string, node?: string) =>
    issues.push({ severity: "warning", message, node })

  const byId = new Map<string, FlowNode>()
  for (const node of graph.nodes) {
    if (byId.has(node.id)) error(`Two nodes share the id ${node.id}.`, node.id)
    byId.set(node.id, node)
  }
  if (new Set(graph.inputs.map((i) => i.key)).size !== graph.inputs.length)
    error("Two inputs share a name.")
  if (new Set(graph.edges.map((e) => e.id)).size !== graph.edges.length)
    error("Two connections share an id.")

  // W(G): exact, because a body runs at most its loops' product of rounds.
  // Worked out before any other check, so a half-drawn flow still shows it
  for (const node of graph.nodes) {
    let rounds = 1
    const seen = new Set<string>()
    for (let at = node.parent; at && !seen.has(at); at = byId.get(at)?.parent) {
      seen.add(at)
      const loop = byId.get(at)
      if (loop?.type === "loop") rounds *= loop.config.maxIterations
    }
    if (node.type === "agent") bound.agentRuns += rounds * (1 + node.config.retries)
    if (node.type === "step") bound.agentRuns += 1
    if (node.type === "approval") bound.gates += rounds
  }

  const device = graph.target === "device"
  const starts = graph.nodes.filter((n) => n.type === "start")
  const ends = graph.nodes.filter((n) => n.type === "end")
  if (starts.length !== 1) error("A flow has exactly one Start.")
  if (ends.length === 0) error("A flow needs a Finish.")
  for (const node of graph.nodes) {
    if (node.parent) {
      const parent = byId.get(node.parent)
      if (parent?.type !== "loop")
        error("This node sits in something that isn't a loop.", node.id)
      if (node.type === "start" || node.type === "end")
        error(`${node.title} can't be inside a loop.`, node.id)
    }
    if (depthOf(node, byId) > LIMITS.depth)
      error(`Loops can nest ${LIMITS.depth} deep at most.`, node.id)
    if (device && !["start", "step", "end"].includes(node.type))
      error("A flow for your computer has only steps.", node.id)
    if (!device && node.type === "step")
      error("Steps belong to a flow for your computer.", node.id)
    if (node.type === "agent" && !node.config.agentId)
      error(`Choose an agent for "${node.title}".`, node.id)
    if (node.type === "agent" && !node.config.prompt.trim())
      error(`Tell "${node.title}" what to do.`, node.id)
  }

  const edges: FlowEdge[] = []
  for (const edge of graph.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) {
      error("A connection points at a node that isn't there.", edge.from)
      continue
    }
    if (!PORTS[from.type].includes(edge.port)) {
      error(`${from.title} has no "${edge.port}" way out.`, from.id)
      continue
    }
    // Entering or leaving a body is what the loop's own ports are for
    if (scopeOf(from) !== scopeOf(to)) {
      error("Connect to the loop itself, not across its edge.", from.id)
      continue
    }
    if (to.type === "start") {
      error("Nothing can lead into Start.", to.id)
      continue
    }
    edges.push(edge)
  }
  if (new Set(edges.map((e) => `${e.from}:${e.port}:${e.to}`)).size !== edges.length)
    error("Two connections join the same ports.")

  const incoming: Plan["incoming"] = {}
  const outgoing: Plan["outgoing"] = {}
  for (const node of graph.nodes) {
    incoming[node.id] = []
    outgoing[node.id] = []
  }
  for (const edge of edges) {
    incoming[edge.to].push(edge)
    outgoing[edge.from].push(edge)
  }

  const children: Plan["children"] = {}
  const scopes = new Set(graph.nodes.map(scopeOf))
  for (const scope of scopes) {
    const ids = graph.nodes.filter((n) => scopeOf(n) === scope).map((n) => n.id)
    const inside = edges.filter((e) => ids.includes(e.from) && ids.includes(e.to))
    const order = topological(ids, inside)
    if (order) children[scope] = order
    else {
      error(
        "This flow goes round in a circle. To repeat work, put it in a loop.",
        scope || undefined
      )
      children[scope] = ids
    }
  }
  if (!children[""]) children[""] = []

  if (issues.some((i) => i.severity === "error")) return { issues, bound, plan: null }

  const plan: Plan = {
    nodes: Object.fromEntries(byId),
    children,
    incoming,
    outgoing,
    inputs: graph.inputs,
  }

  // Everything is on a path from Start
  const reached = new Set<string>(starts.map((n) => n.id))
  for (const id of children[""]) {
    if (reached.has(id)) outgoing[id].forEach((e) => reached.add(e.to))
  }
  for (const id of children[""])
    if (!reached.has(id)) error(`Nothing leads to "${byId.get(id)!.title}".`, id)
  if (ends.length && !ends.some((n) => reached.has(n.id)))
    error("No path reaches a Finish.")

  for (const node of graph.nodes) {
    if (node.type === "loop") {
      const body = children[node.id] ?? []
      const until = byId.get(node.config.until)
      if (body.length === 0) error(`Put at least one step in "${node.title}".`, node.id)
      else if (until?.type !== "check" || until.parent !== node.id)
        error(`"${node.title}" needs a check in its body that ends it.`, node.id)
      if (outgoing[node.id].every((e) => e.port !== "exhausted"))
        warn(`If "${node.title}" runs out of rounds, the flow stops there.`, node.id)
    }
    const until = node.parent ? byId.get(node.parent) : undefined
    const isUntil = until?.type === "loop" && until.config.until === node.id
    if (node.type === "check" && !isUntil) {
      if (outgoing[node.id].every((e) => e.port !== "fail"))
        warn(`If "${node.title}" fails, the flow stops there.`, node.id)
    }
    if (node.type === "approval" && outgoing[node.id].every((e) => e.port !== "declined"))
      warn(`If you decline "${node.title}", the flow stops there.`, node.id)
    if (["end", "loop"].includes(node.type)) continue
    if (
      PORTS[node.type].length > 0 &&
      outgoing[node.id].length === 0 &&
      !isUntil &&
      !node.parent
    )
      warn(`Nothing comes after "${node.title}".`, node.id)
  }

  // A reference must name something that has run by then (SD-06)
  const inputs = new Set(graph.inputs.map((i) => i.key))
  for (const node of graph.nodes) {
    const earlier = before(plan, node.id)
    const inLoop = Boolean(node.parent)
    for (const text of templatesOf(node))
      for (const ref of refsIn(text)) {
        if (ref.root === "input") {
          if (!ref.field || !inputs.has(ref.field))
            error(`${ref.raw} isn't one of this flow's inputs.`, node.id)
        } else if (ref.root === "loop") {
          if (!inLoop) error(`${ref.raw} only works inside a loop.`, node.id)
          else if (!["iteration", "feedback", "last"].includes(ref.field ?? ""))
            error(`${ref.raw} isn't something a loop provides.`, node.id)
        } else if (ref.field) {
          error(`${ref.raw}: name a step, without a field.`, node.id)
        } else if (!earlier.has(ref.root)) {
          error(`${ref.raw} doesn't run before "${node.title}".`, node.id)
        }
      }
    if (node.type === "check" && node.config.rule.kind === "tool_ran") {
      const named = byId.get(node.config.rule.node)
      if (named?.type !== "agent" || !earlier.has(named.id))
        error(`"${node.title}" must name an agent that runs before it.`, node.id)
    }
  }

  if (bound.agentRuns > maxAgentRuns)
    error(
      `In the worst case this runs agents ${bound.agentRuns} times; the limit is ${maxAgentRuns}. Lower a loop's rounds or remove a retry.`
    )

  if (device) {
    const steps = graph.nodes.filter((n) => n.type === "step")
    if (steps.length === 0) error("Add at least one step.")
    if (steps.length > LIMITS.steps)
      error(`Kriya's loop plans ${LIMITS.steps} steps at most.`)
    const start = starts[0]
    if (start?.type === "start" && !start.config.goal?.trim())
      error("Say what the goal is.", start.id)
    for (const step of steps)
      if (step.type === "step" && !step.config.doneWhen.trim())
        error(`Say when "${step.title}" is done.`, step.id)
    if (!graph.profile) error("A flow for your computer needs its harness settings.")
    else if (
      !graph.profile.loopV2 &&
      steps.some(
        (s) => incoming[s.id].filter((e) => byId.get(e.from)?.type === "step").length > 1
      )
    )
      warn("Without Loop v2 these steps run one after another, in order.")
  } else if (!graph.nodes.some((n) => n.type === "check")) {
    warn("No check: nothing verifies this flow's work, and Compare can't judge it.")
  }

  const failed = issues.some((i) => i.severity === "error")
  return { issues, bound, plan: failed ? null : plan }
}

/** JSON with sorted keys: Postgres jsonb doesn't keep the order they were written in */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

// Positions don't change what a flow does, so tidying isn't a new version
export function semanticGraph(graph: FlowGraph) {
  return {
    ...graph,
    nodes: [...graph.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => ({ ...node, at: { x: 0, y: 0 } })),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export type GraphDiff = {
  added: string[]
  removed: string[]
  changed: { id: string; fields: string[] }[]
  edgesAdded: string[]
  edgesRemoved: string[]
  settings: string[]
}

/** What differs between two versions, ignoring positions */
export function diffGraphs(a: FlowGraph, b: FlowGraph): GraphDiff {
  const left = new Map(a.nodes.map((n) => [n.id, n]))
  const right = new Map(b.nodes.map((n) => [n.id, n]))
  const fields = (x: FlowNode, y: FlowNode) => {
    const out: string[] = []
    if (x.title !== y.title) out.push("title")
    if (x.type !== y.type) out.push("type")
    if (x.parent !== y.parent) out.push("place")
    const cx = x.config as Record<string, unknown>
    const cy = y.config as Record<string, unknown>
    for (const key of new Set([...Object.keys(cx), ...Object.keys(cy)]))
      if (canonical(cx[key]) !== canonical(cy[key])) out.push(key)
    return out
  }
  const name = (e: FlowEdge) => `${e.from}:${e.port}:${e.to}`
  const edgesA = new Set(a.edges.map(name))
  const edgesB = new Set(b.edges.map(name))
  return {
    added: b.nodes.filter((n) => !left.has(n.id)).map((n) => n.id),
    removed: a.nodes.filter((n) => !right.has(n.id)).map((n) => n.id),
    changed: b.nodes.flatMap((n) => {
      const old = left.get(n.id)
      const changed = old ? fields(old, n) : []
      return changed.length ? [{ id: n.id, fields: changed }] : []
    }),
    edgesAdded: [...edgesB].filter((e) => !edgesA.has(e)),
    edgesRemoved: [...edgesA].filter((e) => !edgesB.has(e)),
    settings: (["inputs", "limits", "profile"] as const).filter(
      (k) => canonical(a[k]) !== canonical(b[k])
    ),
  }
}
