import type { FlowNodeRun } from "@/db/schema"

import type { NodeRow } from "./engine"

export const asRow = (r: FlowNodeRun): NodeRow => ({
  nodeId: r.nodeId,
  scope: r.scope,
  attempt: r.attempt,
  status: r.status,
  port: r.port,
  iteration: r.iteration,
  output: r.output,
  detail: r.detail,
})
