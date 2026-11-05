import { describe, expect, it } from "vitest"

import { compile, type Plan } from "@/lib/flows/compile"
import {
  decide,
  judge,
  latestRows,
  resolveText,
  runPassed,
  type Decision,
  type NodeRow,
} from "@/lib/flows/engine"
import type { FlowGraph } from "@/lib/flows/graph"

import { agent, check, edge, end, gate, graph, loop, merge, start } from "./fixtures"

// A tiny interpreter for the decisions: it plays the worker's part, with
// `agentResult` standing in for a task. Everything else is the real engine.
type Outcome = { status?: "done" | "failed"; output?: string; sideEffects?: string[] }

function simulate(
  g: FlowGraph,
  agentResult: (node: string, scope: string, attempt: number) => Outcome,
  gateAnswer: (node: string) => "approved" | "declined" = () => "approved",
  maxPasses = 2000
) {
  const compiled = compile(g)
  expect(compiled.issues.filter((i) => i.severity === "error")).toEqual([])
  const plan = compiled.plan as Plan
  const rows: NodeRow[] = []
  let peak = 0
  for (let pass = 0; pass < maxPasses; pass++) {
    // Tasks finish between passes
    const running = rows.filter(
      (r) => r.status === "running" && plan.nodes[r.nodeId].type === "agent"
    )
    peak = Math.max(peak, running.length)
    for (const row of running) {
      const r = agentResult(row.nodeId, row.scope, row.attempt)
      row.status = r.status ?? "done"
      row.output = r.output ?? "out"
      row.detail = { sideEffects: r.sideEffects }
      row.port =
        row.status === "done"
          ? "out"
          : (plan.outgoing[row.nodeId] ?? []).some((e) => e.port === "error")
            ? "error"
            : null
      if (row.status === "failed") row.detail.reason = "boom"
    }
    for (const d of decide(plan, rows, { maxActive: 2 })) {
      if (d.kind === "finish") return { ...d, rows, plan, peak }
      apply(plan, rows, d, gateAnswer)
    }
  }
  throw new Error("did not finish")
}

function apply(
  plan: Plan,
  rows: NodeRow[],
  d: Decision,
  gateAnswer: (node: string) => "approved" | "declined"
) {
  const add = (over: Partial<NodeRow>) =>
    rows.push({
      nodeId: "",
      scope: "",
      attempt: 1,
      status: "done",
      port: null,
      iteration: 1,
      output: null,
      detail: {},
      ...over,
    })
  if (d.kind === "skip") add({ nodeId: d.node, scope: d.scope, status: "skipped" })
  if (d.kind === "round" || d.kind === "settle_loop") {
    const row = rows.find((r) => r.nodeId === d.node && r.scope === d.scope)!
    if (d.kind === "round") row.iteration = d.iteration
    else {
      row.status = "done"
      row.port = d.port
      row.output = d.output
      row.detail.reason = d.reason
    }
  }
  if (d.kind !== "start") return
  const node = plan.nodes[d.node]
  const scope = { rows: latestRows(rows), inputs: {} }
  const base = { nodeId: d.node, scope: d.scope, attempt: d.attempt }
  if (node.type === "agent") return add({ ...base, status: "running" })
  if (node.type === "loop") return add({ ...base, status: "running" })
  if (node.type === "approval") return add({ ...base, port: gateAnswer(d.node) })
  if (node.type === "check") {
    const value = resolveText(plan, scope, node, d.scope, node.config.subject)
    const v = judge(node.config.rule, value, () => 0)
    return add({
      ...base,
      port: v.pass ? "pass" : "fail",
      output: value,
      detail: { reason: v.reason, subjectHash: value },
    })
  }
  add({ ...base, port: "out", output: "" })
}

const seq = () =>
  graph(
    [start(), agent("a"), agent("b", "{{a}}"), end("{{b}}")],
    [edge("start", "a"), edge("a", "b"), edge("b", "end")]
  )

const nodes = (rows: NodeRow[], status = "done") =>
  rows.filter((r) => r.status === status).map((r) => r.nodeId)

describe("ST-E: the engine", () => {
  it("runs in order and finishes", () => {
    const run = simulate(seq(), () => ({}))
    expect(run.status).toBe("completed")
    expect(nodes(run.rows)).toEqual(["start", "a", "b", "end"])
  })

  it("branches: only the taken path runs, the other is skipped", () => {
    const g = graph(
      [
        start(),
        agent("a"),
        check("c", "{{a}}", "yes"),
        agent("good"),
        agent("bad"),
        merge("m"),
        end(),
      ],
      [
        edge("start", "a"),
        edge("a", "c"),
        edge("c", "good", "pass"),
        edge("c", "bad", "fail"),
        edge("good", "m"),
        edge("bad", "m"),
        edge("m", "end"),
      ]
    )
    const run = simulate(g, () => ({ output: "yes please" }))
    expect(run.status).toBe("completed")
    expect(nodes(run.rows, "skipped")).toEqual(["bad"])
    expect(nodes(run.rows)).toContain("m")
  })

  it("skipping propagates (dead-path elimination)", () => {
    const g = graph(
      [
        start(),
        check("c", "no", "yes"),
        agent("x"),
        agent("y", "{{x}}"),
        agent("other"),
        end(),
      ],
      [
        edge("start", "c"),
        edge("c", "x", "pass"),
        edge("x", "y"),
        edge("c", "other", "fail"),
        edge("y", "end"),
        edge("other", "end"),
      ]
    )
    const run = simulate(g, () => ({}))
    expect(nodes(run.rows, "skipped").sort()).toEqual(["x", "y"])
    expect(run.status).toBe("completed")
  })

  it("parallel branches join, within the concurrency limit", () => {
    const g = graph(
      [start(), agent("a"), agent("b"), agent("c"), merge("m"), end()],
      [
        edge("start", "a"),
        edge("start", "b"),
        edge("start", "c"),
        edge("a", "m"),
        edge("b", "m"),
        edge("c", "m"),
        edge("m", "end"),
      ]
    )
    const run = simulate(g, () => ({}))
    expect(run.status).toBe("completed")
    expect(run.peak).toBe(2)
  })

  it("a loop ends when its check passes", () => {
    const g = graph(
      [
        start(),
        loop("l", "c", 5),
        agent("a", "x", "l"),
        check("c", "{{a}}", "good", "l"),
        end("{{l}}"),
      ],
      [edge("start", "l"), edge("a", "c"), edge("l", "end", "done")]
    )
    const run = simulate(g, (_n, scope) => ({
      output: scope === "l#3" ? "good now" : `try ${scope}`,
    }))
    expect(run.status).toBe("completed")
    expect(run.rows.filter((r) => r.nodeId === "a").map((r) => r.scope)).toEqual([
      "l#1",
      "l#2",
      "l#3",
    ])
    expect(run.rows.find((r) => r.nodeId === "l")?.port).toBe("done")
  })

  it("a loop stops at its maximum and takes the exhausted way out", () => {
    const g = graph(
      [
        start(),
        loop("l", "c", 3),
        agent("a", "x", "l"),
        check("c", "{{a}}", "never", "l"),
        agent("fix"),
        end(),
      ],
      [
        edge("start", "l"),
        edge("a", "c"),
        edge("l", "fix", "exhausted"),
        edge("l", "end", "done"),
        edge("fix", "end"),
      ]
    )
    let n = 0
    const run = simulate(g, () => ({ output: `attempt ${n++}` }))
    expect(run.rows.filter((r) => r.nodeId === "a")).toHaveLength(3)
    expect(run.rows.find((r) => r.nodeId === "l")?.detail.reason).toMatch(/all 3 rounds/)
    expect(run.status).toBe("completed")
  })

  it("no progress stops a loop early", () => {
    const g = graph(
      [
        start(),
        loop("l", "c", 8),
        agent("a", "x", "l"),
        check("c", "{{a}}", "never", "l"),
        end(),
      ],
      [edge("start", "l"), edge("a", "c"), edge("l", "end", "done")]
    )
    const run = simulate(g, () => ({ output: "the same thing" }))
    expect(run.rows.filter((r) => r.nodeId === "a")).toHaveLength(2)
    expect(run.status).toBe("failed")
    expect(run.reason).toMatch(/changed nothing/)
  })

  it("nested loops run their rounds independently", () => {
    const g = graph(
      [
        start(),
        loop("outer", "oc", 2),
        loop("inner", "ic", 2, "outer"),
        agent("a", "x", "inner"),
        check("ic", "{{a}}", "fine", "inner"),
        check("oc", "{{inner}}", "final", "outer"),
        end(),
      ],
      [
        edge("start", "outer"),
        edge("a", "ic"),
        edge("inner", "oc", "done"),
        edge("outer", "end", "done"),
      ]
    )
    const run = simulate(g, (_n, scope) => ({
      output:
        scope === "outer#2/inner#2"
          ? "fine final"
          : scope.endsWith("#2")
            ? "fine"
            : "nope " + scope,
    }))
    expect(run.status).toBe("completed")
    expect(run.rows.filter((r) => r.nodeId === "a").map((r) => r.scope)).toEqual([
      "outer#1/inner#1",
      "outer#1/inner#2",
      "outer#2/inner#1",
      "outer#2/inner#2",
    ])
  })

  it("a failure with no route stops new work and fails the run", () => {
    const g = graph(
      [start(), agent("a"), agent("b"), agent("after", "{{a}}"), merge("m"), end()],
      [
        edge("start", "a"),
        edge("start", "b"),
        edge("a", "after"),
        edge("after", "m"),
        edge("b", "m"),
        edge("m", "end"),
      ]
    )
    const run = simulate(g, (n) => (n === "a" ? { status: "failed" } : {}))
    expect(run.status).toBe("failed")
    expect(run.reason).toMatch(/a: boom/)
    expect(run.rows.some((r) => r.nodeId === "after")).toBe(false)
  })

  it("an error route recovers", () => {
    const g = graph(
      [start(), agent("a"), agent("fallback"), end()],
      [
        edge("start", "a"),
        edge("a", "end"),
        edge("a", "fallback", "error"),
        edge("fallback", "end"),
      ]
    )
    const run = simulate(g, (n) => (n === "a" ? { status: "failed" } : {}))
    expect(run.status).toBe("completed")
    expect(nodes(run.rows)).toContain("fallback")
  })

  it("retries a failed node, within its limit", () => {
    const g = graph(
      [start(), agent("a", "x", undefined, 2), end()],
      [edge("start", "a"), edge("a", "end")]
    )
    const ok = simulate(g, (_n, _s, attempt) => (attempt < 3 ? { status: "failed" } : {}))
    expect(ok.status).toBe("completed")
    expect(ok.rows.filter((r) => r.nodeId === "a")).toHaveLength(3)
    const out = simulate(g, () => ({ status: "failed" }))
    expect(out.status).toBe("failed")
    expect(out.rows.filter((r) => r.nodeId === "a")).toHaveLength(3)
  })

  it("ST-RETRY: never retries after a side effect", () => {
    const g = graph(
      [start(), agent("a", "x", undefined, 2), end()],
      [edge("start", "a"), edge("a", "end")]
    )
    const run = simulate(g, () => ({ status: "failed", sideEffects: ["gmail_draft"] }))
    expect(run.status).toBe("failed")
    expect(run.rows.filter((r) => r.nodeId === "a")).toHaveLength(1)
  })

  it("a declined gate takes its own path, or stops the flow", () => {
    const routed = graph(
      [start(), gate("g"), agent("yes"), agent("no"), end()],
      [
        edge("start", "g"),
        edge("g", "yes", "approved"),
        edge("g", "no", "declined"),
        edge("yes", "end"),
        edge("no", "end"),
      ]
    )
    const run = simulate(
      routed,
      () => ({}),
      () => "declined"
    )
    expect(run.status).toBe("completed")
    expect(nodes(run.rows, "skipped")).toEqual(["yes"])
    const open = graph(
      [start(), gate("g"), end()],
      [edge("start", "g"), edge("g", "end", "approved")]
    )
    const stopped = simulate(
      open,
      () => ({}),
      () => "declined"
    )
    expect(stopped.status).toBe("failed")
    expect(stopped.reason).toMatch(/Stopped at "g"/)
  })

  it("a run isn't finished while something waits", () => {
    const g = graph(
      [start(), gate("g"), end()],
      [edge("start", "g"), edge("g", "end", "approved")]
    )
    const plan = compile(g).plan!
    const rows: NodeRow[] = [
      {
        nodeId: "start",
        scope: "",
        attempt: 1,
        status: "done",
        port: "out",
        iteration: 1,
        output: "",
        detail: {},
      },
      {
        nodeId: "g",
        scope: "",
        attempt: 1,
        status: "waiting",
        port: null,
        iteration: 1,
        output: null,
        detail: {},
      },
    ]
    expect(decide(plan, rows)).toEqual([])
  })

  it("every random graph finishes within its bound (termination)", () => {
    // Deterministic pseudo-random, so a failure reproduces
    let seed = 42
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let i = 0; i < 300; i++) {
      const g = randomGraph(rand)
      const { bound, plan } = compile(g, { maxAgentRuns: 10_000 })
      expect(plan, `graph ${i}`).not.toBeNull()
      let runs = 0
      const run = simulate(g, () => {
        runs++
        const r = rand(5)
        return { status: r === 0 ? "failed" : "done", output: `v${rand(1000)}` }
      })
      expect(["completed", "failed"]).toContain(run.status)
      expect(runs, `graph ${i}`).toBeLessThanOrEqual(bound.agentRuns)
    }
  })
})

function randomGraph(rand: (n: number) => number) {
  const nodes = [start()]
  const edges = []
  const ids: { id: string; port: string }[] = [{ id: "start", port: "out" }]
  const count = 2 + rand(8)
  for (let i = 0; i < count; i++) {
    const id = `n${i}`
    const kind = rand(5)
    const from = ids[rand(ids.length)]
    if (kind === 0) {
      nodes.push(check(id, "v", "1"))
      ids.push({ id, port: "pass" }, { id, port: "fail" })
    } else if (kind === 1) {
      const body = `${id}b`
      const until = `${id}c`
      nodes.push(
        loop(id, until, 1 + rand(3)),
        agent(body, "x", id, rand(2)),
        check(until, `{{${body}}}`, "9", id)
      )
      edges.push(edge(body, until))
      ids.push({ id, port: "done" }, { id, port: "exhausted" })
    } else if (kind === 2) {
      nodes.push(merge(id))
      ids.push({ id, port: "out" })
    } else {
      nodes.push(agent(id, "x", undefined, rand(3)))
      ids.push({ id, port: "out" })
      if (rand(2)) ids.push({ id, port: "error" })
    }
    edges.push(edge(from.id, id, from.port))
    if (rand(3) === 0) {
      const extra = ids[rand(ids.length)]
      if (
        extra.id !== id &&
        !edges.some((e) => e.from === extra.id && e.to === id && e.port === extra.port) &&
        ids.findIndex((x) => x.id === extra.id) < ids.findIndex((x) => x.id === id)
      )
        edges.push(edge(extra.id, id, extra.port))
    }
  }
  nodes.push(end())
  const last = ids.at(-1)!
  edges.push(edge(last.id, "end", last.port))
  return graph(nodes, edges)
}

describe("judging", () => {
  const none = () => 0
  it("each rule decides by code", () => {
    expect(judge({ kind: "contains", text: "OK" }, "all ok", none).pass).toBe(true)
    expect(judge({ kind: "not_contains", text: "OK" }, "all ok", none).pass).toBe(false)
    expect(judge({ kind: "equals", text: "Yes" }, " yes ", none).pass).toBe(true)
    expect(judge({ kind: "min_chars", n: 5 }, "abc", none).reason).toMatch(/3 characters/)
    expect(judge({ kind: "max_chars", n: 2 }, "abc", none).pass).toBe(false)
    expect(
      judge({ kind: "number_at_least", n: 1000 }, "Total ₹1,250.50", none).pass
    ).toBe(true)
    expect(judge({ kind: "number_at_most", n: 10 }, "none here", none).pass).toBe(false)
  })

  it("tool_ran reads evidence, not the text", () => {
    const rule = { kind: "tool_ran" as const, node: "a", tool: "gmail_draft", atLeast: 2 }
    expect(judge(rule, "I saved two drafts!", () => 1).pass).toBe(false)
    expect(judge(rule, "", () => 2).pass).toBe(true)
  })
})

describe("a run's verdict", () => {
  it("needs completion and no unrouted failed check", () => {
    const g = graph(
      [start(), check("c", "x", "y"), end()],
      [edge("start", "c"), edge("c", "end", "pass")]
    )
    const plan = compile(g).plan!
    const row = (nodeId: string, port: string): NodeRow => ({
      nodeId,
      scope: "",
      attempt: 1,
      status: "done",
      port,
      iteration: 1,
      output: "",
      detail: {},
    })
    expect(runPassed(plan, "completed", [row("c", "pass")])).toBe(true)
    expect(runPassed(plan, "completed", [row("c", "fail")])).toBe(false)
    expect(runPassed(plan, "failed", [row("c", "pass")])).toBe(false)
  })
})
