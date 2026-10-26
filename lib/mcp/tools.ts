import { createHash } from "node:crypto"

import type { MCPClient } from "@ai-sdk/mcp"
import { tool, type Tool } from "ai"
import { z } from "zod"

import type { McpVerify } from "@/db/schema"
import { canonical } from "@/lib/agent/episodes"
import { FOREIGN } from "@/lib/agent/tools"
import { readBack } from "@/lib/mcp/verify"
import { TransientError } from "@/lib/reliability/retry"

// One Kriya tool per owner-pinned MCP tool (TOOLS_AND_CONTRACTS §2). The
// model sees the owner's description and the pinned input schema, never
// the live server's; the call goes to the server's own tool name.

export const MAX_INPUT_CHARS = 32_768
const MAX_RESULT_CHARS = 20_000
const MAX_ERROR_CHARS = 500
export const CALL_TIMEOUT_MS = 30_000
const TRANSIENT_HTTP = new Set([429, 502, 503, 504])

// The parts of a definition the owner pins; a change to any of them is drift (ND-07)
const PINNED = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
]
// Only those parts are stored and hashed; the server's other fields are not ours to trust
export const pinnedDefinition = (definition: Record<string, unknown>) =>
  Object.fromEntries(
    PINNED.filter((key) => definition[key] !== undefined).map((key) => [
      key,
      definition[key],
    ])
  )
// Which pinned parts differ, for the owner's side-by-side review
export const changedParts = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  PINNED.filter((key) => canonical(a[key]) !== canonical(b[key]))
export function definitionHash(definition: Record<string, unknown>) {
  return createHash("sha256")
    .update(canonical(pinnedDefinition(definition)))
    .digest("hex")
}

export type PinnedTool = {
  name: string
  kriyaName: string
  description: string
  // The full definition the owner pinned (ND-07)
  definition: unknown
}

// Strict: no field the pinned schema doesn't name, and at most 32 KB
export function pinnedSchema(inputSchema: unknown) {
  const schema = z.fromJSONSchema({
    ...(inputSchema as object),
    type: "object",
    additionalProperties: false,
  })
  return schema.refine((input) => JSON.stringify(input).length <= MAX_INPUT_CHARS, {
    message: "The input is too large for this app.",
  })
}

const textOf = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .filter((item): item is { type: "text"; text: string } => item?.type === "text")
    .map((item) => item.text)
    .join("\n")

// `check`: the owner's read-back spec for a side effect, already matched to a
// pinned read tool of this server (ND-12)
export function mcpTool(
  client: MCPClient,
  pin: PinnedTool,
  app: string,
  check?: McpVerify
): Tool {
  const schema = pinnedSchema((pin.definition as { inputSchema?: unknown }).inputSchema)
  return tool({
    description: `${pin.description} (in ${app})`,
    inputSchema: schema,
    execute: async (input, { abortSignal }) => {
      const args = schema.parse(input) as Record<string, unknown>
      const result = await client
        .callTool({
          name: pin.name,
          arguments: args,
          options: { signal: abortSignal, timeout: CALL_TIMEOUT_MS },
        })
        .catch((error: { statusCode?: number }) => {
          // A busy app (N4): the reliability wrapper retries a safe read on this
          if (error?.statusCode && TRANSIENT_HTTP.has(error.statusCode))
            throw new TransientError(error.statusCode)
          throw error
        })
      if (result.isError) {
        throw new Error(
          `${app} said: ${textOf(result.content).slice(0, MAX_ERROR_CHARS) || "the action failed."}`
        )
      }
      const verification = check
        ? await readBack(
            check,
            { input: args, structuredContent: result.structuredContent },
            (readArgs) =>
              client.callTool({
                name: check.tool,
                arguments: readArgs,
                options: { signal: abortSignal, timeout: CALL_TIMEOUT_MS },
              })
          )
        : undefined
      return {
        notice: FOREIGN,
        result:
          result.structuredContent ?? textOf(result.content).slice(0, MAX_RESULT_CHARS),
        ...(verification && { verification }),
      }
    },
  })
}
