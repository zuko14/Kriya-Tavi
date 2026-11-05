import { z } from "zod"

import { HarnessProfile } from "@/lib/harness/evolve/profile-schema"

// A flow's canonical shape (docs/kriya-studio/ARCHITECTURE.md §3). Pure, so
// the editor and the server validate with the same code; the server is the
// boundary. Every object is strict: a graph is untrusted input, and it has
// no field for a risk class, an approval, a limit or a secret (SD-07).

export const LIMITS = {
  nodes: 60,
  edges: 120,
  inputs: 8,
  title: 80,
  text: 4000,
  depth: 2,
  iterations: 10,
  retries: 2,
  // Loop v2's own bound (kriya-harness src/loop.js MAX_STEPS)
  steps: 7,
  goal: 600,
  doneWhen: 300,
  files: 12,
} as const

const Id = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
const Title = z.string().trim().min(1).max(LIMITS.title)
const Text = z.string().max(LIMITS.text)

export const Rule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("contains"), text: z.string().min(1).max(400) }),
  z.strictObject({ kind: z.literal("not_contains"), text: z.string().min(1).max(400) }),
  z.strictObject({ kind: z.literal("equals"), text: z.string().max(400) }),
  z.strictObject({
    kind: z.literal("min_chars"),
    n: z.number().int().min(0).max(100_000),
  }),
  z.strictObject({
    kind: z.literal("max_chars"),
    n: z.number().int().min(0).max(100_000),
  }),
  z.strictObject({ kind: z.literal("number_at_least"), n: z.number().finite() }),
  z.strictObject({ kind: z.literal("number_at_most"), n: z.number().finite() }),
  // Evidence, not text: this agent node's own verified tool runs
  z.strictObject({
    kind: z.literal("tool_ran"),
    node: Id,
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    atLeast: z.number().int().min(1).max(100),
  }),
])
export type Rule = z.infer<typeof Rule>

const Base = {
  id: Id,
  title: Title,
  // A loop's id when the node is in its body
  parent: Id.optional(),
  at: z.strictObject({
    x: z.number().finite().min(-1e6).max(1e6),
    y: z.number().finite().min(-1e6).max(1e6),
  }),
}

export const FlowNode = z.discriminatedUnion("type", [
  z.strictObject({
    ...Base,
    type: z.literal("start"),
    // A device flow's goal (Loop v2's plan.goal)
    config: z.strictObject({ goal: z.string().max(LIMITS.goal).optional() }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal("agent"),
    config: z.strictObject({
      agentId: z.string().max(32),
      prompt: Text,
      retries: z.number().int().min(0).max(LIMITS.retries),
    }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal("check"),
    config: z.strictObject({ subject: Text, rule: Rule }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal("approval"),
    config: z.strictObject({
      message: Text,
      expiresHours: z.number().int().min(1).max(168),
    }),
  }),
  z.strictObject({ ...Base, type: z.literal("merge"), config: z.strictObject({}) }),
  z.strictObject({
    ...Base,
    type: z.literal("loop"),
    config: z.strictObject({
      maxIterations: z.number().int().min(1).max(LIMITS.iterations),
      // The check in the body whose pass ends the loop
      until: Id,
    }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal("end"),
    config: z.strictObject({ result: Text }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal("step"),
    config: z.strictObject({
      doneWhen: z.string().max(LIMITS.doneWhen),
      files: z.array(z.string().min(1).max(200)).max(LIMITS.files),
    }),
  }),
])
export type FlowNode = z.infer<typeof FlowNode>
export type NodeType = FlowNode["type"]

// An edge is always control; its meaning is its source port (SD-06)
export const PORTS: Record<NodeType, string[]> = {
  start: ["out"],
  agent: ["out", "error"],
  check: ["pass", "fail"],
  approval: ["approved", "declined"],
  merge: ["out"],
  loop: ["done", "exhausted"],
  end: [],
  step: ["out"],
}

export const FlowEdge = z.strictObject({
  id: z.string().regex(/^[a-z0-9_:-]{1,100}$/),
  from: Id,
  port: z.string().regex(/^[a-z]{1,12}$/),
  to: Id,
})
export type FlowEdge = z.infer<typeof FlowEdge>

export const FlowInput = z.strictObject({
  key: Id,
  label: Title,
  required: z.boolean(),
  long: z.boolean(),
})
export type FlowInput = z.infer<typeof FlowInput>

export const TARGETS = ["cloud", "device"] as const
export type Target = (typeof TARGETS)[number]

export const FlowGraph = z.strictObject({
  schema: z.literal(1),
  target: z.enum(TARGETS),
  inputs: z.array(FlowInput).max(LIMITS.inputs),
  nodes: z.array(FlowNode).max(LIMITS.nodes),
  edges: z.array(FlowEdge).max(LIMITS.edges),
  limits: z.strictObject({
    // Whole rupees for one run; null means the plan's limits alone
    budgetInr: z.number().int().min(1).max(100_000).nullable(),
  }),
  // Device flows only: the part of the harness KRHE may vary
  profile: HarnessProfile.optional(),
})
export type FlowGraph = z.infer<typeof FlowGraph>

export const emptyGraph = (target: Target = "cloud"): FlowGraph => ({
  schema: 1,
  target,
  inputs: [],
  nodes: [
    { id: "start", type: "start", title: "Start", at: { x: 0, y: 0 }, config: {} },
    {
      id: "end",
      type: "end",
      title: "Finish",
      at: { x: 0, y: 0 },
      config: { result: "" },
    },
  ],
  edges: [{ id: "start:out:end", from: "start", port: "out", to: "end" }],
  limits: { budgetInr: null },
})

const REF = /\{\{\s*([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?\s*\}\}/g

export type Ref = { root: string; field?: string; raw: string }

/** The {{…}} references in a text, in order */
export const refsIn = (text: string): Ref[] =>
  [...text.matchAll(REF)].map((m) => ({ root: m[1], field: m[2], raw: m[0] }))

/** Each reference replaced by what `value` gives for it */
export const fill = (text: string, value: (ref: Ref) => string) =>
  text.replace(REF, (raw, root: string, field?: string) => value({ root, field, raw }))

/** The texts of a node that may hold references */
export function templatesOf(node: FlowNode): string[] {
  switch (node.type) {
    case "agent":
      return [node.config.prompt]
    case "check":
      return [node.config.subject]
    case "approval":
      return [node.config.message]
    case "end":
      return [node.config.result]
    default:
      return []
  }
}
