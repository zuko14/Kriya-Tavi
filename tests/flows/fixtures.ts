import {
  emptyGraph,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@/lib/flows/graph"

const at = { x: 0, y: 0 }
export const start = (): FlowNode => ({
  id: "start",
  type: "start",
  title: "Start",
  at,
  config: {},
})
export const end = (result = ""): FlowNode => ({
  id: "end",
  type: "end",
  title: "Finish",
  at,
  config: { result },
})
export const agent = (
  id: string,
  prompt = "Do it",
  parent?: string,
  retries = 0
): FlowNode => ({
  id,
  type: "agent",
  title: id,
  at,
  ...(parent && { parent }),
  config: { agentId: "a1", prompt, retries },
})
export const check = (
  id: string,
  subject: string,
  text: string,
  parent?: string
): FlowNode => ({
  id,
  type: "check",
  title: id,
  at,
  ...(parent && { parent }),
  config: { subject, rule: { kind: "contains", text } },
})
export const gate = (id: string): FlowNode => ({
  id,
  type: "approval",
  title: id,
  at,
  config: { message: "Go ahead?", expiresHours: 24 },
})
export const merge = (id: string): FlowNode => ({
  id,
  type: "merge",
  title: id,
  at,
  config: {},
})
export const loop = (
  id: string,
  until: string,
  maxIterations = 3,
  parent?: string
): FlowNode => ({
  id,
  type: "loop",
  title: id,
  at,
  ...(parent && { parent }),
  config: { maxIterations, until },
})
export const edge = (from: string, to: string, port = "out"): FlowEdge => ({
  id: `${from}:${port}:${to}`,
  from,
  port,
  to,
})
export const graph = (
  nodes: FlowNode[],
  edges: FlowEdge[],
  extra: Partial<FlowGraph> = {}
): FlowGraph => ({
  ...emptyGraph(),
  nodes,
  edges,
  ...extra,
})
