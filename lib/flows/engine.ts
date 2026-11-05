import { fill, type FlowNode, type Rule } from "./graph"
import type { Plan } from "./compile"

// What happens next (ARCHITECTURE §5, SD-08): a pure function of the plan and
// the node rows, so it can be tested without a database and the worker can
// die between any two statements. Join semantics are dead-path elimination
// (SD-06): a node runs when every incoming edge is resolved and at least one
// was taken; none taken means skipped, which propagates.

export const ACTIVE = ["running", "waiting"] as const
export type NodeStatus =
  "running" | "waiting" | "done" | "failed" | "skipped" | "canceled"

export type NodeRow = {
  nodeId: string
  scope: string
  attempt: number
  status: NodeStatus
  port: string | null
  // A loop's current round
  iteration: number
  output: string | null
  detail: RowDetail
}

export type RowDetail = {
  // Why it failed or stopped, in the person's words
  reason?: string
  // Successful tool runs by name, from tool_executions (never model text)
  tools?: Record<string, number>
  sideEffects?: string[]
  // It, or something it read from, touched private content (SD-11)
  tainted?: boolean
  // What a check judged, to spot a loop making no progress
  subjectHash?: string
  // An approval's deadline
  expiresAt?: string
}

export type Decision =
  | { kind: "start"; node: string; scope: string; attempt: number; iteration: number }
  | { kind: "skip"; node: string; scope: string }
  | { kind: "round"; node: string; scope: string; iteration: number }
  | {
      kind: "settle_loop"
      node: string
      scope: string
      port: "done" | "exhausted"
      // What the loop hands on: what its check judged in the last round
      output: string | null
      reason?: string
    }
  | { kind: "finish"; status: "completed" | "failed"; reason?: string }

const SETTLED: NodeStatus[] = ["done", "failed", "skipped", "canceled"]
export const isSettled = (row: NodeRow) => SETTLED.includes(row.status)

export const childScope = (scope: string, loop: string, round: number) =>
  `${scope ? `${scope}/` : ""}${loop}#${round}`

/** The latest attempt of each (node, scope) */
export function latestRows(rows: NodeRow[]) {
  const out = new Map<string, NodeRow>()
  for (const row of rows) {
    const key = `${row.scope}|${row.nodeId}`
    const seen = out.get(key)
    if (!seen || row.attempt > seen.attempt) out.set(key, row)
  }
  return out
}

// A failed node with no error route stops the flow
const blocks = (plan: Plan, row: NodeRow) =>
  row.status === "failed" &&
  !(plan.outgoing[row.nodeId] ?? []).some((e) => e.port === row.port)

const retriesLeft = (plan: Plan, row: NodeRow) => {
  const node = plan.nodes[row.nodeId]
  if (row.status !== "failed" || node?.type !== "agent") return false
  // Never after a side effect (track N rule 9)
  if (row.detail.sideEffects?.length) return false
  return row.attempt <= node.config.retries
}

export function decide(
  plan: Plan,
  rows: NodeRow[],
  { maxActive = 4 }: { maxActive?: number } = {}
): Decision[] {
  const latest = latestRows(rows)
  const row = (node: string, scope: string) => latest.get(`${scope}|${node}`)
  const out: Decision[] = []
  const all = [...latest.values()]
  const stopped = all.some((r) => blocks(plan, r) && !retriesLeft(plan, r))
  let active = all.filter(
    (r) => r.status === "running" && plan.nodes[r.nodeId]?.type === "agent"
  ).length

  const start = (node: FlowNode, scope: string, attempt: number) => {
    if (stopped) return
    if (node.type === "agent") {
      if (active >= maxActive) return
      active++
    }
    out.push({ kind: "start", node: node.id, scope, attempt, iteration: 1 })
  }

  // Walks one scope; true once every node in it is settled
  const walk = (parent: string, scope: string): boolean => {
    let settled = true
    for (const id of plan.children[parent] ?? []) {
      const node = plan.nodes[id]
      const mine = row(id, scope)
      if (mine) {
        if (node.type === "loop" && mine.status === "running") {
          settled = false
          round(node, mine, scope)
        } else if (retriesLeft(plan, mine)) {
          settled = false
          start(node, scope, mine.attempt + 1)
        } else if (!isSettled(mine)) settled = false
        continue
      }
      settled = false
      const edges = plan.incoming[id] ?? []
      const sources = edges.map((e) => ({ e, r: row(e.from, scope) }))
      // A source about to retry hasn't decided anything yet
      if (sources.some(({ r }) => !r || !isSettled(r) || retriesLeft(plan, r))) continue
      const taken = sources.some(
        ({ e, r }) => r!.status !== "skipped" && r!.port === e.port
      )
      if (edges.length > 0 && !taken) {
        if (!stopped) out.push({ kind: "skip", node: id, scope })
      } else start(node, scope, 1)
    }
    return settled
  }

  const round = (
    loop: Extract<FlowNode, { type: "loop" }>,
    mine: NodeRow,
    scope: string
  ) => {
    const inner = childScope(scope, loop.id, mine.iteration)
    if (!walk(loop.id, inner) || stopped) return
    const until = row(loop.config.until, inner)
    const settle = {
      kind: "settle_loop" as const,
      node: loop.id,
      scope,
      output: until?.output ?? null,
    }
    if (until?.status === "done" && until.port === "pass") {
      out.push({ ...settle, port: "done" })
      return
    }
    const earlier =
      mine.iteration > 1
        ? row(loop.config.until, childScope(scope, loop.id, mine.iteration - 1))
        : undefined
    const hash = until?.detail.subjectHash
    if (hash && earlier?.detail.subjectHash === hash) {
      out.push({
        ...settle,
        port: "exhausted",
        reason: "Stopped early: this round changed nothing.",
      })
    } else if (mine.iteration >= loop.config.maxIterations) {
      out.push({
        ...settle,
        port: "exhausted",
        reason: `Used all ${loop.config.maxIterations} rounds without passing.`,
      })
    } else
      out.push({ kind: "round", node: loop.id, scope, iteration: mine.iteration + 1 })
  }

  const done = walk("", "")
  if (
    out.length > 0 ||
    all.some((r) => ACTIVE.some((s) => s === r.status) && !isLoopRow(plan, r))
  )
    return out
  if (!stopped && !done) return out
  return [conclude(plan, all, stopped)]
}

const isLoopRow = (plan: Plan, row: NodeRow) => plan.nodes[row.nodeId]?.type === "loop"

function conclude(plan: Plan, rows: NodeRow[], stopped: boolean): Decision {
  const failed = rows.find((r) => blocks(plan, r))
  if (stopped && failed)
    return {
      kind: "finish",
      status: "failed",
      reason: `${plan.nodes[failed.nodeId].title}: ${failed.detail.reason ?? "it failed."}`,
    }
  if (rows.some((r) => plan.nodes[r.nodeId]?.type === "end" && r.status === "done"))
    return { kind: "finish", status: "completed" }
  // Stopped short: say where the path ended
  const last = rows
    .filter((r) => r.status === "done" && !r.scope)
    .filter((r) => !(plan.outgoing[r.nodeId] ?? []).some((e) => e.port === r.port))
    .at(-1)
  return {
    kind: "finish",
    status: "failed",
    reason: last
      ? `Stopped at "${plan.nodes[last.nodeId].title}"${last.detail.reason ? `: ${last.detail.reason}` : "."}`
      : "The flow didn't reach Finish.",
  }
}

/* ───────────────────────────── values ───────────────────────────── */

export type Scope = { rows: Map<string, NodeRow>; inputs: Record<string, string> }

/** A node's output as seen from `scope`: this round, then outward */
export function valueOf(s: Scope, node: string, scope: string) {
  for (let at = scope; ; at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "") {
    const row = s.rows.get(`${at}|${node}`)
    if (row) return row
    if (!at) return undefined
  }
}

// The enclosing loop's facts for {{loop.*}}: its round, and why the last failed
export function loopFacts(plan: Plan, s: Scope, node: FlowNode, scope: string) {
  const loop = node.parent ? plan.nodes[node.parent] : undefined
  if (loop?.type !== "loop") return null
  const here = scope.slice(scope.lastIndexOf("/") + 1)
  const round = Number(here.split("#")[1] ?? 1)
  const stem = scope.slice(0, scope.lastIndexOf("#"))
  const last =
    round > 1 ? s.rows.get(`${stem}#${round - 1}|${loop.config.until}`) : undefined
  return {
    iteration: String(round),
    feedback: last?.detail.reason ?? "",
    last: last?.output ?? "",
  }
}

export function resolveText(
  plan: Plan,
  s: Scope,
  node: FlowNode,
  scope: string,
  text: string
) {
  const facts = loopFacts(plan, s, node, scope)
  return fill(text, ({ root, field }) => {
    if (root === "input") return s.inputs[field ?? ""] ?? ""
    if (root === "loop") return facts?.[field as keyof typeof facts] ?? ""
    return valueOf(s, root, scope)?.output ?? ""
  })
}

const firstNumber = (text: string) => {
  const m = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

/** A rule's verdict over a value and recorded evidence; pass or a reason */
export function judge(
  rule: Rule,
  value: string,
  tools: (node: string, name: string) => number
) {
  const lower = value.toLowerCase()
  const fail = (reason: string) => ({ pass: false, reason })
  const ok = { pass: true, reason: "" }
  switch (rule.kind) {
    case "contains":
      return lower.includes(rule.text.toLowerCase())
        ? ok
        : fail(`It doesn't mention "${rule.text}".`)
    case "not_contains":
      return lower.includes(rule.text.toLowerCase())
        ? fail(`It mentions "${rule.text}".`)
        : ok
    case "equals":
      return value.trim().toLowerCase() === rule.text.trim().toLowerCase()
        ? ok
        : fail(`It isn't "${rule.text}".`)
    case "min_chars":
      return value.trim().length >= rule.n
        ? ok
        : fail(`It has ${value.trim().length} characters; it needs ${rule.n}.`)
    case "max_chars":
      return value.trim().length <= rule.n
        ? ok
        : fail(`It has ${value.trim().length} characters; the limit is ${rule.n}.`)
    case "number_at_least":
    case "number_at_most": {
      const n = firstNumber(value)
      if (n === null) return fail("It has no number in it.")
      const pass = rule.kind === "number_at_least" ? n >= rule.n : n <= rule.n
      return pass
        ? ok
        : fail(
            `The number is ${n}; it should be ${rule.kind === "number_at_least" ? "at least" : "at most"} ${rule.n}.`
          )
    }
    case "tool_ran": {
      const n = tools(rule.node, rule.tool)
      return n >= rule.atLeast
        ? ok
        : fail(
            `${rule.tool} succeeded ${n} ${n === 1 ? "time" : "times"}; it needs ${rule.atLeast}.`
          )
    }
  }
}

/** The run's verdict for Compare: code over rows, never model text (SD-13) */
export function runPassed(plan: Plan, status: string, rows: NodeRow[]) {
  if (status !== "completed") return false
  return [...latestRows(rows).values()].every((row) => {
    const node = plan.nodes[row.nodeId]
    if (node?.type === "loop") return row.port === "done"
    if (node?.type !== "check") return true
    const loop = node.parent ? plan.nodes[node.parent] : undefined
    if (loop?.type === "loop" && loop.config.until === node.id) return true
    return (
      row.port === "pass" || (plan.outgoing[node.id] ?? []).some((e) => e.port === "fail")
    )
  })
}
