import { asSchema, type ToolSet } from "ai"

import { canonical } from "@/lib/agent/episodes"

// NM7 (COST_AND_METERING §3): how much of the tool definitions a model reads
// are an app's. Counted in characters, as the plan says (no token estimate, no
// price). Measured at belt build and logged as numbers only; nothing is stored.

const definitionChars = async (name: string, tool: ToolSet[string]) => {
  const schema = await asSchema(tool.inputSchema).jsonSchema
  return name.length + (tool.description?.length ?? 0) + canonical(schema).length
}

export async function definitionShare(tools: ToolSet, appTools: Iterable<string>) {
  const apps = new Set(appTools)
  let app = 0
  let total = 0
  for (const [name, tool] of Object.entries(tools)) {
    const chars = await definitionChars(name, tool)
    total += chars
    if (apps.has(name)) app += chars
  }
  // null when there are no tools at all, never 0 of nothing
  return { app, total, share: total === 0 ? null : app / total }
}
