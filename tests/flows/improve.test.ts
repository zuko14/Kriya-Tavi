import { describe, expect, it } from "vitest"

import { compile } from "@/lib/flows/compile"
import { compareVerdict, type CompareRun } from "@/lib/flows/compare"
import { proposeFlow, type Evidence } from "@/lib/flows/improve"
import { emptyGraph } from "@/lib/flows/graph"
import {
  freeSpot,
  layoutGraph,
  portX,
  regionSize,
  unplaced,
  wirePoints,
  withLayout,
} from "@/lib/flows/layout"
import { DEVICE_TEMPLATE, TEMPLATES, withAgent } from "@/lib/flows/templates"
import { Draft, toGraph } from "@/lib/flows/copilot"

import { agent, check, edge, end, graph, loop, merge, start } from "./fixtures"

const withLayoutFixture = () =>
  withAgent(TEMPLATES.find((t) => t.id === "write-until-it-passes")!.graph, "a1")

const none: Evidence = { runs: [], rows: [] }
const row = (runId: string, nodeId: string, over = {}) => ({
  runId,
  nodeId,
  scope: "",
  attempt: 1,
  status: "done" as const,
  port: "out",
  iteration: 1,
  output: null,
  detail: {},
  ...over,
})

describe("ST-IMP: proposals", () => {
  it("adds a check where there is none, and it's the same every time", () => {
    const g = graph(
      [start(), agent("a"), end("{{a}}")],
      [edge("start", "a"), edge("a", "end")]
    )
    const moves = proposeFlow(g, none)
    expect(moves.map((m) => m.move)).toEqual(["add-check"])
    expect(proposeFlow(g, none)).toEqual(moves)
    expect(compile(moves[0].graph).plan).not.toBeNull()
  })

  it("parallelises only agents that don't read each other", () => {
    const free = graph(
      [start(), agent("a"), agent("b"), check("c", "x", "x"), end()],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end", "pass")]
    )
    const move = proposeFlow(free, none).find((m) => m.move === "parallel")!
    expect(move.graph.edges.map((e) => e.id).sort()).toEqual(
      ["a:out:c", "b:out:c", "c:pass:end", "start:out:a", "start:out:b"].sort()
    )
    const reads = graph(
      [start(), agent("a"), agent("b", "{{a}}"), check("c", "x", "x"), end()],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end", "pass")]
    )
    expect(proposeFlow(reads, none).some((m) => m.move === "parallel")).toBe(false)
  })

  it("suggests a retry only for failures with no side effect", () => {
    const g = graph(
      [start(), agent("a"), check("c", "x", "x"), end()],
      [edge("start", "a"), edge("a", "c"), edge("c", "end", "pass")]
    )
    const failed = (side?: string[]) => ({
      runs: [
        { id: "r1", status: "failed" },
        { id: "r2", status: "failed" },
      ],
      rows: ["r1", "r2"].map((r) =>
        row(r, "a", { status: "failed", port: null, detail: { sideEffects: side } })
      ),
    })
    expect(proposeFlow(g, failed()).map((m) => m.move)).toContain("retry")
    expect(proposeFlow(g, failed(["gmail_draft"])).map((m) => m.move)).not.toContain(
      "retry"
    )
  })

  it("reads a loop's rounds from its runs", () => {
    const g = graph(
      [
        start(),
        loop("l", "c", 5),
        agent("a", "x", "l"),
        check("c", "{{a}}", "y", "l"),
        end(),
      ],
      [edge("start", "l"), edge("a", "c"), edge("l", "end", "done")]
    )
    const runs = ["r1", "r2", "r3"].map((id) => ({ id, status: "completed" }))
    const easy = proposeFlow(g, {
      runs,
      rows: runs.map((r) => row(r.id, "l", { port: "done", iteration: 2 })),
    })
    const fewer = easy.find((m) => m.move === "fewer-rounds")!
    expect(fewer.title).toMatch(/to 3 rounds/)
    const hard = proposeFlow(g, {
      runs,
      rows: runs.map((r) => row(r.id, "l", { port: "exhausted", iteration: 5 })),
    })
    expect(hard.map((m) => m.move)).toContain("more-rounds")
    // Stuck isn't short of rounds
    const stuck = proposeFlow(g, {
      runs,
      rows: runs.map((r) =>
        row(r.id, "l", {
          port: "exhausted",
          detail: { reason: "Stopped early: this round changed nothing." },
        })
      ),
    })
    expect(stuck.map((m) => m.move)).not.toContain("more-rounds")
  })

  it("removes what does nothing", () => {
    const g = graph(
      [start(), agent("a"), merge("m"), check("c", "x", "x"), end()],
      [edge("start", "a"), edge("a", "m"), edge("m", "c"), edge("c", "end", "pass")]
    )
    const move = proposeFlow(g, none).find((m) => m.move === "remove-merge")!
    expect(move.graph.nodes.map((n) => n.id)).not.toContain("m")
    expect(compile(move.graph).plan).not.toBeNull()
  })

  it("never proposes a change that breaks the limit", () => {
    const g = graph(
      [
        start(),
        loop("l", "c", 5),
        agent("a", "x", "l"),
        check("c", "{{a}}", "y", "l"),
        end(),
      ],
      [edge("start", "l"), edge("a", "c"), edge("l", "end", "done")]
    )
    const runs = ["r1", "r2"].map((id) => ({ id, status: "failed" }))
    const rows = runs.map((r) => row(r.id, "l", { port: "exhausted" }))
    expect(proposeFlow(g, { runs, rows }, 5).map((m) => m.move)).not.toContain(
      "more-rounds"
    )
  })
})

describe("ST-IMP: compare, through KRHE's gate", () => {
  const g = graph(
    [start(), check("c", "x", "x"), end()],
    [edge("start", "c"), edge("c", "end", "pass")]
  )
  const plan = compile(g).plan!
  const run = (
    arm: "incumbent" | "candidate",
    caseIndex: number,
    round: number,
    ok: boolean
  ): CompareRun => ({
    arm,
    caseIndex,
    round,
    status: ok ? "completed" : "failed",
    durationMs: 1000,
    costMicroInr: 100n,
    rows: [],
  })
  const pairs = (
    a: (i: number) => boolean,
    b: (i: number) => boolean,
    cases = 4,
    rounds = 3
  ) =>
    Array.from({ length: rounds }, (_, r) =>
      Array.from({ length: cases }, (_, c) => [
        run("incumbent", c, r + 1, a(c)),
        run("candidate", c, r + 1, b(c)),
      ]).flat()
    ).flat()

  it("too little evidence reads hold", () => {
    const { verdict } = compareVerdict(
      "s",
      pairs(
        () => false,
        () => true,
        1,
        1
      ),
      { incumbent: plan, candidate: plan }
    )
    expect(verdict?.verdict).toBe("hold")
    expect(verdict?.reasons.join()).toMatch(/too little evidence/)
  })

  it("a clear win is adopted; a clear loss is rejected", () => {
    const half = (i: number) => i % 2 === 0
    const win = compareVerdict(
      "s",
      pairs(half, () => true),
      { incumbent: plan, candidate: plan }
    )
    expect(win.verdict?.verdict).toBe("adopt")
    const loss = compareVerdict(
      "s",
      pairs(() => true, half),
      { incumbent: plan, candidate: plan }
    )
    expect(loss.verdict?.verdict).toBe("reject")
  })

  it("unpriced runs can't be called cheaper", () => {
    const runs = pairs(
      () => false,
      () => true
    ).map((r) => ({ ...r, costMicroInr: null }))
    const { verdict } = compareVerdict("s", runs, { incumbent: plan, candidate: plan })
    expect(verdict?.reasons.join()).toMatch(/cost per passed task unknown/)
    expect(verdict?.verdict).not.toBe("adopt")
  })

  it("a round still running doesn't count", () => {
    const runs = pairs(
      () => true,
      () => true,
      2,
      2
    )
    runs[0] = { ...runs[0], status: "running" }
    const { pending, verdict } = compareVerdict("s", runs, {
      incumbent: plan,
      candidate: plan,
    })
    expect(pending).toBe(1)
    expect(verdict?.metrics.runs).toBe(1)
  })
})

describe("templates and layout", () => {
  it("every starting point compiles once it has an agent", () => {
    for (const t of TEMPLATES) {
      const { issues, plan } = compile(withAgent(t.graph, "a1"))
      expect(
        issues.filter((i) => i.severity === "error"),
        t.id
      ).toEqual([])
      expect(plan, t.id).not.toBeNull()
    }
    const g = DEVICE_TEMPLATE.graph
    const device = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.type === "start" ? { ...n, config: { goal: "Ship it" } } : n
      ),
    }
    expect(compile(device).issues.filter((i) => i.severity === "error")).toEqual([])
  })

  it("layout is deterministic, and a region holds its body", async () => {
    const g = withAgent(
      TEMPLATES.find((t) => t.id === "write-until-it-passes")!.graph,
      "a1"
    )
    expect(unplaced(g)).toBe(true)
    const [a, b] = await Promise.all([layoutGraph(g), layoutGraph(g)])
    expect(a).toEqual(b)
    const placed = withLayout(g, a)
    expect(unplaced(placed)).toBe(false)
    const size = regionSize(placed, "revise")
    for (const n of placed.nodes.filter((x) => x.parent === "revise")) {
      expect(n.at.x).toBeGreaterThanOrEqual(0)
      expect(n.at.x + 248).toBeLessThanOrEqual(size.w)
      expect(n.at.y + 76).toBeLessThanOrEqual(size.h)
    }
  })

  it("a new flow is laid out, and a new step never covers another", () => {
    expect(unplaced(emptyGraph())).toBe(true)
    const placed = graph(
      [
        { ...start(), at: { x: 0, y: 0 } },
        { ...end(), at: { x: 0, y: 140 } },
      ],
      [edge("start", "end")]
    )
    const spot = freeSpot(placed, { x: 0, y: 140 })
    const overlaps = placed.nodes.some(
      (n) => Math.abs(n.at.x - spot.x) < 248 && Math.abs(n.at.y - spot.y) < 76
    )
    expect(overlaps).toBe(false)
    expect(freeSpot(placed, { x: 600, y: 0 })).toEqual({ x: 600, y: 0 })
  })

  it("the good path leaves from the centre", () => {
    expect(portX("agent", "out")).toBe(124)
    expect(portX("check", "pass")).toBe(124)
    expect(portX("check", "fail")).toBeGreaterThan(124)
  })

  it("a wire stays orthogonal, whatever the region's handles did", () => {
    const wire = wirePoints(
      { x: 10, y: 0 },
      [
        { x: 40, y: 50 },
        { x: 40, y: 200 },
      ],
      { x: 90, y: 260 }
    )!
    for (let i = 1; i < wire.length; i++)
      expect(wire[i].x === wire[i - 1].x || wire[i].y === wire[i - 1].y).toBe(true)
    expect(wire.at(0)).toEqual({ x: 10, y: 0 })
    expect(wire.at(-1)).toEqual({ x: 90, y: 260 })
    expect(wirePoints({ x: 0, y: 0 }, [], { x: 0, y: 9 })).toBeNull()
    // A route that starts straight under its handle keeps its corners
    const lined = wirePoints(
      { x: 100, y: 0 },
      [
        { x: 100, y: 40 },
        { x: 20, y: 40 },
      ],
      {
        x: 20,
        y: 90,
      }
    )!
    expect(lined).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 20, y: 40 },
      { x: 20, y: 90 },
    ])
  })

  it("a skipping edge is routed clear of the card between", async () => {
    const g = withLayoutFixture()
    const { at, routes } = await layoutGraph(g)
    const route = routes["revise:done:end"]
    expect(route.length).toBeGreaterThan(0)
    const card = at.rescue
    const hits = route.some(
      (p) => p.x > card.x && p.x < card.x + 248 && p.y > card.y && p.y < card.y + 76
    )
    expect(hits).toBe(false)
  })

  it("a chain's nodes line up", async () => {
    const g = graph(
      [start(), agent("a"), agent("b"), check("c", "x", "x"), end()],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end", "pass")]
    )
    const { at } = await layoutGraph(g)
    expect(new Set(Object.values(at).map((p) => p.x)).size).toBe(1)
    const ys = ["start", "a", "b", "c", "end"].map((id) => at[id].y)
    expect([...ys].sort((x, y) => x - y)).toEqual(ys)
  })
})

describe("ST-COP: a model's draft", () => {
  const agents = [{ id: "a1" }, { id: "a2" }]
  const draft: Draft = {
    name: "Reminder",
    why: "Simple.",
    inputs: [{ key: "client", label: "Client" }],
    nodes: [
      { id: "start", type: "start", title: "Start" },
      {
        id: "draft",
        type: "agent",
        title: "Draft",
        agent: "a2",
        prompt: "Write to {{input.client}}",
      },
      { id: "end", type: "end", title: "Finish", result: "{{draft}}" },
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "end" },
    ],
  }

  it("becomes a graph the validator accepts", () => {
    const g = toGraph(draft, "cloud", agents)!
    expect(compile(g).plan).not.toBeNull()
    expect(g.nodes[1]).toMatchObject({ config: { agentId: "a2" } })
    expect(g.inputs[0].required).toBe(true)
  })

  it("only the person's agents: anything else is theirs, never the model's", () => {
    const g = toGraph(
      {
        ...draft,
        nodes: draft.nodes.map((n) =>
          n.type === "agent" ? { ...n, agent: "someone-elses" } : n
        ),
      },
      "cloud",
      agents
    )!
    expect(g.nodes[1]).toMatchObject({ config: { agentId: "a1" } })
  })

  it("refuses types and rules that don't exist (S10)", () => {
    expect(
      toGraph(
        { ...draft, nodes: [...draft.nodes, { id: "x", type: "shell", title: "X" }] },
        "cloud",
        agents
      )
    ).toBeNull()
    expect(
      toGraph(
        {
          ...draft,
          nodes: [
            ...draft.nodes,
            {
              id: "c",
              type: "check",
              title: "C",
              rule: { kind: "regex", text: "(a+)+" },
            },
          ],
        },
        "cloud",
        agents
      )
    ).toBeNull()
  })
})
