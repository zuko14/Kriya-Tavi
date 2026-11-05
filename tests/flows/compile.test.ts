import { describe, expect, it } from "vitest"

import { canonical, compile, diffGraphs, semanticGraph } from "@/lib/flows/compile"
import { emptyGraph, FlowGraph, LIMITS } from "@/lib/flows/graph"
import { BASELINE } from "@/lib/harness/evolve/profile"

import { agent, check, edge, end, gate, graph, loop, merge, start } from "./fixtures"

const errors = (g: unknown, options = {}) =>
  compile(g, options)
    .issues.filter((i) => i.severity === "error")
    .map((i) => i.message)

const simple = () =>
  graph([start(), agent("a"), end("{{a}}")], [edge("start", "a"), edge("a", "end")])

describe("ST-G: graph validation", () => {
  it("accepts a simple flow and the empty one", () => {
    expect(errors(simple())).toEqual([])
    expect(errors(emptyGraph())).toEqual([])
  })

  it("refuses unknown fields, so a graph can't name a protected control", () => {
    expect(errors({ ...simple(), approvals: "off" })[0]).toMatch(/isn't valid/)
    const g = simple()
    expect(
      errors({ ...g, nodes: [{ ...g.nodes[1], risk: "R0" }, g.nodes[0], g.nodes[2]] })[0]
    ).toMatch(/isn't valid/)
  })

  it("refuses too many nodes", () => {
    const many = Array.from({ length: LIMITS.nodes + 1 }, (_, i) => agent(`n${i}`))
    expect(errors(graph(many, []))[0]).toMatch(/isn't valid/)
  })

  it("has no rule that takes a regular expression (S8)", () => {
    const g = graph(
      [
        start(),
        {
          ...check("c", "x", "y"),
          config: { subject: "x", rule: { kind: "regex", text: "(a+)+" } },
        } as never,
        end(),
      ],
      [edge("start", "c")]
    )
    expect(FlowGraph.safeParse(g).success).toBe(false)
  })

  it("refuses a cycle and points at loops", () => {
    const g = graph(
      [start(), agent("a"), agent("b"), end()],
      [edge("start", "a"), edge("a", "b"), edge("b", "a"), edge("b", "end")]
    )
    expect(errors(g).join()).toMatch(/round in a circle/)
  })

  it("needs one Start and a reachable Finish", () => {
    expect(errors(graph([agent("a"), end()], [edge("a", "end")])).join()).toMatch(
      /one Start/
    )
    expect(errors(graph([start(), agent("a")], [edge("start", "a")])).join()).toMatch(
      /needs a Finish/
    )
    expect(
      errors(graph([start(), agent("a"), end()], [edge("start", "a")])).join()
    ).toMatch(/Nothing leads to|No path/)
  })

  it("refuses an unknown port, and edges across a loop's edge", () => {
    expect(
      errors(
        graph(
          [start(), agent("a"), end()],
          [edge("start", "a"), edge("a", "end", "nope")]
        )
      ).join()
    ).toMatch(/no "nope"/)
    const g = graph(
      [
        start(),
        loop("l", "c"),
        agent("a", "x", "l"),
        check("c", "{{a}}", "y", "l"),
        end(),
      ],
      [edge("start", "a"), edge("l", "end", "done")]
    )
    expect(errors(g).join()).toMatch(/across its edge/)
  })

  it("checks references against what runs before", () => {
    const g = graph(
      [start(), agent("a", "{{b}}"), agent("b"), end()],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")]
    )
    expect(errors(g).join()).toMatch(/doesn't run before/)
    expect(
      errors(
        graph(
          [start(), agent("a", "{{input.nope}}"), end()],
          [edge("start", "a"), edge("a", "end")]
        )
      ).join()
    ).toMatch(/isn't one of this flow's inputs/)
    expect(
      errors(
        graph(
          [start(), agent("a", "{{loop.feedback}}"), end()],
          [edge("start", "a"), edge("a", "end")]
        )
      ).join()
    ).toMatch(/only works inside a loop/)
  })

  it("a body can read what ran before its loop, and the outside reads the loop", () => {
    const g = graph(
      [
        start(),
        agent("first"),
        loop("l", "c"),
        agent("a", "{{first}} {{loop.feedback}} {{loop.last}} {{loop.iteration}}", "l"),
        check("c", "{{a}}", "ok", "l"),
        end("{{l}}"),
      ],
      [
        edge("start", "first"),
        edge("first", "l"),
        edge("a", "c"),
        edge("l", "end", "done"),
      ]
    )
    expect(errors(g)).toEqual([])
  })

  it("a loop needs its check in its body; nesting stops at two", () => {
    const g = graph(
      [start(), loop("l", "c"), agent("a", "x", "l"), check("c", "x", "y"), end()],
      [edge("start", "l"), edge("l", "c", "done"), edge("c", "end", "pass")]
    )
    expect(errors(g).join()).toMatch(/needs a check in its body/)
    const deep = graph(
      [
        start(),
        loop("l1", "c1"),
        check("c1", "x", "y", "l1"),
        loop("l2", "c2", 2, "l1"),
        check("c2", "x", "y", "l2"),
        loop("l3", "c3", 2, "l2"),
        check("c3", "x", "y", "l3"),
        end(),
      ],
      [
        edge("start", "l1"),
        edge("l1", "end", "done"),
        edge("l2", "c1", "done"),
        edge("l3", "c2", "done"),
      ]
    )
    expect(errors(deep).join()).toMatch(/nest 2 deep/)
  })

  it("the worst case is exact, and capped (S2)", () => {
    const nested = graph(
      [
        start(),
        loop("l1", "c1", 3),
        check("c1", "x", "y", "l1"),
        loop("l2", "c2", 2, "l1"),
        agent("a", "x", "l2", 1),
        check("c2", "x", "y", "l2"),
        agent("b"),
        gate("g"),
        end(),
      ],
      [
        edge("start", "l1"),
        edge("l2", "c1", "done"),
        edge("a", "c2"),
        edge("l1", "b", "done"),
        edge("b", "g"),
        edge("g", "end", "approved"),
      ]
    )
    const { bound, issues } = compile(nested)
    expect(issues.filter((i) => i.severity === "error")).toEqual([])
    // a: 3 × 2 rounds × (1 + 1 retry) = 12; b: 1
    expect(bound).toEqual({ agentRuns: 13, gates: 1 })
    expect(errors(nested, { maxAgentRuns: 12 }).join()).toMatch(
      /13 times; the limit is 12/
    )
  })

  it("a half-drawn flow still shows its worst case", () => {
    const a = agent("a", "")
    const g = graph([start(), a, end()], [edge("start", "a"), edge("a", "end")])
    const { bound, plan } = compile(g)
    expect(plan).toBeNull()
    expect(bound.agentRuns).toBe(1)
  })

  it("warns about ways out that lead nowhere", () => {
    const g = graph(
      [start(), check("c", "x", "y"), gate("g"), end()],
      [edge("start", "c"), edge("c", "g", "pass"), edge("g", "end", "approved")]
    )
    const warnings = compile(g).issues.filter((i) => i.severity === "warning")
    expect(warnings.map((w) => w.message).join()).toMatch(/If "c" fails/)
    expect(warnings.map((w) => w.message).join()).toMatch(/If you decline "g"/)
  })

  it("merge joins branches", () => {
    const g = graph(
      [start(), agent("a"), agent("b"), merge("m"), end("{{m}}")],
      [
        edge("start", "a"),
        edge("start", "b"),
        edge("a", "m"),
        edge("b", "m"),
        edge("m", "end"),
      ]
    )
    expect(errors(g)).toEqual([])
  })

  it("device flows have only steps, within Loop v2's bounds (S12)", () => {
    const step = (id: string) => ({
      id,
      type: "step" as const,
      title: id,
      at: { x: 0, y: 0 },
      config: { doneWhen: "tests pass", files: [] },
    })
    const base = {
      ...emptyGraph("device"),
      profile: BASELINE,
      nodes: [{ ...start(), config: { goal: "Fix it" } } as never, step("s1"), end()],
      edges: [edge("start", "s1"), edge("s1", "end")],
    }
    expect(errors(base)).toEqual([])
    expect(errors({ ...base, profile: undefined }).join()).toMatch(/harness settings/)
    expect(errors({ ...base, nodes: [...base.nodes, agent("a")] }).join()).toMatch(
      /only steps/
    )
    const eight = Array.from({ length: 8 }, (_, i) => step(`s${i}`))
    expect(errors({ ...base, nodes: [base.nodes[0], ...eight, end()] }).join()).toMatch(
      /7 steps/
    )
    // A protected harness control has no field
    expect(errors({ ...base, profile: { ...BASELINE, approvals: "off" } })[0]).toMatch(
      /isn't valid/
    )
  })
})

describe("versions", () => {
  it("positions aren't part of what a flow does", () => {
    const a = simple()
    const b = { ...a, nodes: a.nodes.map((n) => ({ ...n, at: { x: 9, y: 9 } })) }
    expect(semanticGraph(a)).toEqual(semanticGraph(b))
  })

  it("key order isn't a change: Postgres jsonb reorders keys", () => {
    const a = graph(
      [start(), check("c", "x", "y"), end()],
      [edge("start", "c"), edge("c", "end", "pass")]
    )
    const reordered = {
      ...a,
      nodes: a.nodes.map((n) =>
        n.type === "check"
          ? ({
              ...n,
              config: { rule: { text: "y", kind: "contains" }, subject: "x" },
            } as typeof n)
          : n
      ),
    }
    const d = diffGraphs(a, reordered)
    expect(d.changed).toEqual([])
    expect(canonical(semanticGraph(a))).toBe(canonical(semanticGraph(reordered)))
  })

  it("names what changed", () => {
    const a = simple()
    const b = graph(
      [start(), agent("a", "Do it better"), agent("c"), end("{{a}}")],
      [edge("start", "a"), edge("a", "c"), edge("c", "end")]
    )
    expect(diffGraphs(a, b)).toEqual({
      added: ["c"],
      removed: [],
      changed: [{ id: "a", fields: ["prompt"] }],
      edgesAdded: ["a:out:c", "c:out:end"],
      edgesRemoved: ["a:out:end"],
      settings: [],
    })
  })
})
