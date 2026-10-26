import { z } from "zod"

import type { McpVerify, Verification } from "@/db/schema"
import { canonical } from "@/lib/agent/episodes"

// Read-back mapping (ND-12, MCP_CONNECTIVITY §7). An owner-written spec says
// how to read a side effect back: another pinned read tool of the same
// server, its arguments taken from the first call's input or structured
// result by JSON pointer, and which fields must match. Run by the worker
// right after the call, without the model. Pure: the caller supplies the read.

// Where a pointer may point: the first call's input and structured result;
// in the read's answer only its structured result. No `~` escapes (v1).
const FIRST = /^\/(structuredContent|input)(\/[^/~]+)*$/
const READ = /^\/structuredContent(\/[^/~]+)*$/

export const MAX_SPEC_FIELDS = 8

const fields = <T extends z.ZodType>(value: T, key: z.ZodString) =>
  z
    .record(key, value)
    .refine(
      (o) => Object.keys(o).length >= 1 && Object.keys(o).length <= MAX_SPEC_FIELDS,
      {
        message: `Between 1 and ${MAX_SPEC_FIELDS} fields.`,
      }
    )

export const verifySpecSchema = z
  .object({
    // The server's own name for the read tool
    tool: z.string().min(1).max(128),
    args: fields(z.string().regex(FIRST).max(200), z.string().min(1).max(64)),
    expect: fields(z.string().regex(FIRST).max(200), z.string().regex(READ).max(200)),
  })
  .strict()

export function pointerGet(root: unknown, pointer: string): unknown {
  let node = root
  for (const key of pointer.split("/").slice(1)) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key))
      return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

export type Read = (args: Record<string, unknown>) => Promise<Record<string, unknown>>

const unverified = (note: string): Verification => ({
  status: "unverified",
  method: "api_readback",
  evidence: [],
  note,
})

export async function readBack(
  spec: McpVerify,
  first: { input: unknown; structuredContent?: unknown },
  read: Read
): Promise<Verification> {
  const args: Record<string, unknown> = {}
  for (const [name, pointer] of Object.entries(spec.args)) {
    const value = pointerGet(first, pointer)
    if (value === undefined) return unverified("The app didn't say what to look up.")
    args[name] = value
  }
  // The thing looked up, so a later check can find it again
  const id = Object.values(args).find(
    (v): v is string | number =>
      (typeof v === "string" && v.length <= 200) || typeof v === "number"
  )
  const evidence: Verification["evidence"] =
    id === undefined ? [] : [{ kind: "provider_id", value: String(id) }]

  let answer: Awaited<ReturnType<Read>>
  try {
    answer = await read(args)
  } catch {
    return { ...unverified("Checked: the app couldn't be read."), evidence }
  }
  if (answer.isError)
    return { ...unverified("Checked: the app couldn't read it."), evidence }

  let missing = false
  for (const [at, from] of Object.entries(spec.expect)) {
    const want = pointerGet(first, from)
    const got = pointerGet({ structuredContent: answer.structuredContent }, at)
    if (want === undefined || got === undefined) missing = true
    else if (canonical(got) !== canonical(want))
      return {
        status: "failed",
        method: "api_readback",
        evidence,
        note: "Checked: the app shows something different.",
      }
  }
  if (missing)
    return { ...unverified("Checked: the app didn't show everything."), evidence }
  return {
    status: "verified",
    method: "api_readback",
    evidence,
    note: "Checked: the app shows what was sent.",
  }
}
