import { compile, type Plan } from "./compile"
import type { NodeRow } from "./engine"
import { latestRows } from "./engine"
import { refsIn, templatesOf, type FlowGraph, type FlowNode } from "./graph"

// Improve (SD-13), KRHE's Propose stage for flows: one-factor changes, so a
// measured effect can be put down to one change, ranked by the flow's own
// runs. No model and no randomness: the same evidence proposes the same
// moves. No move can reach a guard, approval or limit: the graph has no field
// for them. Applying one is the person's click; whether it was better is
// Compare's, through KRHE's gate.

export const MAX_MOVES = 5

export type Evidence = {
  runs: { id: string; status: string }[]
  rows: (NodeRow & { runId: string })[]
}

export type Move = {
  move: string
  title: string
  hypothesis: string
  overhead: string
  evidence: string
  // How strongly the runs point at it; 0 is shape alone
  signal: number
  graph: FlowGraph
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

// Which earlier nodes a node reads
const reads = (node: FlowNode) =>
  new Set(templatesOf(node).flatMap((t) => refsIn(t).map((r) => r.root)))

function addCheck(graph: FlowGraph, plan: Plan): Move[] {
  if (graph.nodes.some((n) => n.type === "check")) return []
  const end = graph.nodes.find((n) => n.type === "end")
  const edge = graph.edges.find(
    (e) => e.to === end?.id && plan.nodes[e.from]?.type === "agent"
  )
  if (!edge) return []
  const last = plan.nodes[edge.from]
  const id = "has_substance"
  if (plan.nodes[id]) return []
  return [
    {
      move: "add-check",
      title: `Check "${last.title}" before finishing`,
      hypothesis:
        "A rule over the result catches an empty or thin answer, and lets Compare judge this flow",
      overhead: "None: a check is code, with no model call",
      evidence: "No check in this flow",
      signal: 0,
      graph: {
        ...graph,
        nodes: [
          ...graph.nodes,
          {
            id,
            type: "check",
            title: "Has substance",
            at: { x: 0, y: 0 },
            config: { subject: `{{${last.id}}}`, rule: { kind: "min_chars", n: 40 } },
          },
        ],
        edges: [
          ...graph.edges.filter((e) => e.id !== edge.id),
          { id: `${edge.from}:out:${id}`, from: edge.from, port: "out", to: id },
          { id: `${id}:pass:${edge.to}`, from: id, port: "pass", to: edge.to },
        ],
      },
    },
  ]
}

// A → B where B doesn't read A: they can run side by side
function parallelise(graph: FlowGraph, plan: Plan): Move[] {
  const out: Move[] = []
  for (const a of graph.nodes) {
    if (a.type !== "agent" || a.parent) continue
    const after = plan.outgoing[a.id]
    if (after.length !== 1 || after[0].port !== "out") continue
    const b = plan.nodes[after[0].to]
    if (b.type !== "agent" || plan.incoming[b.id].length !== 1) continue
    if (reads(b).has(a.id)) continue
    const incoming = plan.incoming[a.id]
    const onward = plan.outgoing[b.id].filter((e) => e.port === "out")
    if (incoming.length === 0 || onward.length === 0) continue
    out.push({
      move: "parallel",
      title: `Run "${a.title}" and "${b.title}" at the same time`,
      hypothesis: `"${b.title}" doesn't read "${a.title}", so it needn't wait`,
      overhead: "None in cost: the same runs, sooner. Both count against concurrency",
      evidence: "Their prompts share no reference",
      signal: 0,
      graph: {
        ...graph,
        edges: [
          ...graph.edges.filter((e) => e.id !== after[0].id),
          ...incoming.map((e) => ({
            id: `${e.from}:${e.port}:${b.id}`,
            from: e.from,
            port: e.port,
            to: b.id,
          })),
          ...onward.map((e) => ({
            id: `${a.id}:out:${e.to}`,
            from: a.id,
            port: "out",
            to: e.to,
          })),
        ],
      },
    })
  }
  return out
}

function configure(graph: FlowGraph, id: string, config: object): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id ? ({ ...n, config: { ...n.config, ...config } } as FlowNode) : n
    ),
  }
}

function fromRuns(graph: FlowGraph, evidence: Evidence): Move[] {
  const out: Move[] = []
  const byRun = new Map<string, (NodeRow & { runId: string })[]>()
  for (const row of evidence.rows)
    byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row])
  const finished = evidence.runs.filter((r) => ["completed", "failed"].includes(r.status))

  for (const node of graph.nodes) {
    if (node.type === "agent" && node.config.retries < 2) {
      const failed = evidence.rows.filter(
        (r) => r.nodeId === node.id && r.status === "failed"
      )
      if (failed.length >= 2 && failed.every((r) => !r.detail.sideEffects?.length))
        out.push({
          move: "retry",
          title: `Let "${node.title}" try again when it fails`,
          hypothesis: "It failed without doing anything real, so another try is safe",
          overhead: "One more agent run when it fails",
          evidence: `Failed ${count(failed.length, "time")}, with no side effects`,
          signal: failed.length,
          graph: configure(graph, node.id, { retries: node.config.retries + 1 }),
        })
    }
    if (node.type !== "loop") continue
    const rows = finished.flatMap((r) =>
      [...latestRows(byRun.get(r.id) ?? []).values()].filter((x) => x.nodeId === node.id)
    )
    const exhausted = rows.filter((r) => r.port === "exhausted")
    const stuck = exhausted.filter((r) => /changed nothing/.test(r.detail.reason ?? ""))
    if (exhausted.length - stuck.length >= 2 && node.config.maxIterations < 10)
      out.push({
        move: "more-rounds",
        title: `Give "${node.title}" another round`,
        hypothesis: "It ran out of rounds while still changing its answer",
        overhead: "One more round of its agents in the worst case",
        evidence: `Used every round in ${count(exhausted.length - stuck.length, "run")}`,
        signal: exhausted.length - stuck.length,
        graph: configure(graph, node.id, {
          maxIterations: node.config.maxIterations + 1,
        }),
      })
    const passed = rows.filter((r) => r.port === "done")
    const most = Math.max(0, ...passed.map((r) => r.iteration))
    if (
      passed.length >= 3 &&
      passed.length === rows.length &&
      most + 1 < node.config.maxIterations
    )
      out.push({
        move: "fewer-rounds",
        title: `Lower "${node.title}" to ${most + 1} rounds`,
        hypothesis:
          "It has never needed its full allowance, so the worst case can shrink",
        overhead: "A rare hard case may stop sooner",
        evidence: `Passed within ${count(most, "round")} in ${count(passed.length, "run")}`,
        signal: passed.length,
        graph: configure(graph, node.id, { maxIterations: most + 1 }),
      })
  }
  return out
}

// What does nothing: the simplest graph that works wins
function simplify(graph: FlowGraph, plan: Plan): Move[] {
  const out: Move[] = []
  for (const node of graph.nodes) {
    if (node.type !== "merge" || plan.incoming[node.id].length !== 1) continue
    const used = graph.nodes.some((n) => reads(n).has(node.id))
    if (used) continue
    const from = plan.incoming[node.id][0]
    out.push({
      move: "remove-merge",
      title: `Remove "${node.title}"`,
      hypothesis: "A merge of one path joins nothing",
      overhead: "None",
      evidence: "It has one way in",
      signal: 0,
      graph: {
        ...graph,
        nodes: graph.nodes.filter((n) => n.id !== node.id),
        edges: [
          ...graph.edges.filter((e) => e.from !== node.id && e.to !== node.id),
          ...plan.outgoing[node.id].map((e) => ({
            id: `${from.from}:${from.port}:${e.to}`,
            from: from.from,
            port: from.port,
            to: e.to,
          })),
        ],
      },
    })
  }
  return out
}

export function proposeFlow(graph: FlowGraph, evidence: Evidence, maxAgentRuns?: number) {
  const { plan } = compile(graph, { maxAgentRuns })
  if (!plan || graph.target !== "cloud") return []
  return [
    ...addCheck(graph, plan),
    ...fromRuns(graph, evidence),
    ...simplify(graph, plan),
    ...parallelise(graph, plan),
  ]
    .filter((m) => compile(m.graph, { maxAgentRuns }).plan)
    .sort((a, b) => b.signal - a.signal)
    .slice(0, MAX_MOVES)
}
