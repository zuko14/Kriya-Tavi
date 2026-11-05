import { BASELINE } from "@/lib/harness/evolve/profile-schema"

import type { FlowEdge, FlowGraph, FlowNode } from "./graph"

// Starting points (journeys 1–4). Pure data: agents are left to fill in when
// a flow is made from one, and the editor lays them out on first open.

const at = { x: 0, y: 0 }
const edge = (from: string, to: string, port = "out"): FlowEdge => ({
  id: `${from}:${port}:${to}`,
  from,
  port,
  to,
})
const start: FlowNode = { id: "start", type: "start", title: "Start", at, config: {} }
const end = (result: string): FlowNode => ({
  id: "end",
  type: "end",
  title: "Finish",
  at,
  config: { result },
})
const agent = (id: string, title: string, prompt: string, parent?: string): FlowNode => ({
  id,
  type: "agent",
  title,
  at,
  ...(parent && { parent }),
  config: { agentId: "", prompt, retries: 0 },
})
const base = (nodes: FlowNode[], edges: FlowEdge[], inputs: FlowGraph["inputs"] = []) =>
  ({
    schema: 1,
    target: "cloud",
    inputs,
    nodes,
    edges,
    limits: { budgetInr: null },
  }) satisfies FlowGraph

export type Template = {
  id: string
  name: string
  blurb: string
  graph: FlowGraph
}

const topic = [{ key: "topic", label: "Topic", required: true, long: false }]

export const TEMPLATES: Template[] = [
  {
    id: "review-before-sending",
    name: "Draft, then let me check",
    blurb: "An agent drafts; nothing goes further until you approve it.",
    graph: base(
      [
        start,
        agent("draft", "Draft it", "Write this for me: {{input.request}}"),
        {
          id: "approve",
          type: "approval",
          title: "Check the draft",
          at,
          config: { message: "{{draft}}", expiresHours: 72 },
        },
        end("{{draft}}"),
      ],
      [
        edge("start", "draft"),
        edge("draft", "approve"),
        edge("approve", "end", "approved"),
      ],
      [{ key: "request", label: "What to write", required: true, long: true }]
    ),
  },
  {
    id: "two-sided-research",
    name: "Research from two sides",
    blurb: "Two agents work at once; a third joins what they found.",
    graph: base(
      [
        start,
        agent(
          "for_case",
          "The case for",
          "Find the strongest case for: {{input.topic}}. Cite sources."
        ),
        agent(
          "against",
          "The case against",
          "Find the strongest case against: {{input.topic}}. Cite sources."
        ),
        { id: "both", type: "merge", title: "Both sides", at, config: {} },
        agent(
          "write",
          "Write it up",
          "Write a balanced one-page brief on {{input.topic}} from {{both}}."
        ),
        end("{{write}}"),
      ],
      [
        edge("start", "for_case"),
        edge("start", "against"),
        edge("for_case", "both"),
        edge("against", "both"),
        edge("both", "write"),
        edge("write", "end"),
      ],
      topic
    ),
  },
  {
    id: "write-until-it-passes",
    name: "Revise until it passes",
    blurb: "A bounded loop: draft, check by rule, fix what failed, three rounds at most.",
    graph: base(
      [
        start,
        {
          id: "revise",
          type: "loop",
          title: "Revise",
          at,
          config: { maxIterations: 3, until: "long_enough" },
        },
        agent(
          "write",
          "Write",
          "Write about {{input.topic}}. This is round {{loop.iteration}}. What failed last time: {{loop.feedback}}. Last version: {{loop.last}}",
          "revise"
        ),
        {
          id: "long_enough",
          type: "check",
          title: "Long enough",
          parent: "revise",
          at,
          config: { subject: "{{write}}", rule: { kind: "min_chars", n: 600 } },
        },
        agent(
          "rescue",
          "Say what's missing",
          "It didn't pass after three rounds. Explain what's missing from {{revise}}."
        ),
        end("{{revise}}"),
      ],
      [
        edge("start", "revise"),
        edge("write", "long_enough"),
        edge("revise", "end", "done"),
        edge("revise", "rescue", "exhausted"),
        edge("rescue", "end"),
      ],
      topic
    ),
  },
]

const step = (id: string, title: string, doneWhen: string): FlowNode => ({
  id,
  type: "step",
  title,
  at,
  config: { doneWhen, files: [] },
})

export const DEVICE_TEMPLATE: Template = {
  id: "plan-build-verify",
  name: "Plan, build, verify",
  blurb: "Steps Kriya's loop builds and checks with your project's own tests.",
  graph: {
    schema: 1,
    target: "device",
    inputs: [],
    nodes: [
      { ...start, config: { goal: "" } } as FlowNode,
      step("change", "Make the change", "The new behaviour works"),
      step("tests", "Cover it with tests", "The project's check passes"),
      end(""),
    ],
    edges: [edge("start", "change"), edge("change", "tests"), edge("tests", "end")],
    limits: { budgetInr: null },
    profile: BASELINE,
  },
}

export const templateById = (id: string) =>
  [...TEMPLATES, DEVICE_TEMPLATE].find((t) => t.id === id)

/** A template with the person's agent on every agent node */
export function withAgent(graph: FlowGraph, agentId: string): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.type === "agent" && !n.config.agentId
        ? { ...n, config: { ...n.config, agentId } }
        : n
    ),
  }
}
