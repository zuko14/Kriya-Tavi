import type { ModelMessage } from "ai"
import { asc, eq } from "drizzle-orm"

import type { Q } from "@/db"
import { messages } from "@/db/schema"
import type { KriyaMessage } from "@/lib/agent/tools"

export async function loadMessages(q: Q, threadId: string) {
  const rows = await q
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt))
  return rows.map(
    (row) =>
      ({
        id: row.id,
        role: row.role,
        parts: row.parts,
        metadata: row.metadata ?? undefined,
      }) as KriyaMessage
  )
}

export async function saveMessage(
  q: Q,
  userId: string,
  threadId: string,
  message: KriyaMessage,
  createdAt = new Date()
) {
  await q
    .insert(messages)
    .values({
      id: message.id,
      threadId,
      userId,
      role: message.role,
      parts: message.parts,
      metadata: message.metadata ?? null,
      createdAt,
    })
    .onConflictDoUpdate({
      target: [messages.threadId, messages.id],
      set: { parts: message.parts, metadata: message.metadata ?? null },
    })
}

// A reply as one line of plain text for previews: Markdown syntax (headings,
// emphasis, rules, tables, links, code fences) removed
export function previewOf(message: Pick<KriyaMessage, "parts">) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S.*?)[*_](?=\W|$)/g, "$1$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function textOf(message: Pick<KriyaMessage, "parts">) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

/* ─────────────────────── context compaction ─────────────────────
 * Every step of a tool loop resends the whole conversation, so before each
 * step only the newest tool outputs stay whole; older ones shrink to a
 * short stub. A long research task costs roughly the same per step at
 * step 30 as at step 3.
 * ────────────────────────────────────────────────────────────────── */

const OUTPUTS_KEPT = 6
const STUB_CHARS = 600

type ToolOutput = { type: string; value?: unknown }

function shrink(output: ToolOutput, keepFull: boolean): ToolOutput {
  if (keepFull) return output
  const raw =
    typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? "")
  if (raw.length <= STUB_CHARS) return output
  return {
    type: "text",
    value: `${raw.slice(0, STUB_CHARS)}… [${raw.length - STUB_CHARS} more characters of an earlier result trimmed]`,
  }
}

export function compactContext(input: ModelMessage[]): ModelMessage[] {
  let outputs = 0
  return input
    .slice()
    .reverse()
    .map((message) => {
      if (message.role !== "tool") return message
      const content = message.content
        .slice()
        .reverse()
        .map((part) => {
          if (part.type !== "tool-result") return part
          const keepFull = outputs < OUTPUTS_KEPT
          outputs++
          return {
            ...part,
            output: shrink(part.output as ToolOutput, keepFull) as typeof part.output,
          }
        })
        .reverse()
      return { ...message, content }
    })
    .reverse()
}

// Readable errors from providers, without leaking request details
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const body = (error as { responseBody?: string }).responseBody
    if (body) {
      try {
        const parsed = JSON.parse(body)
        const detail = parsed?.error?.message ?? parsed?.message
        if (typeof detail === "string")
          return `${error.message} — ${detail.slice(0, 300)}`
      } catch {}
    }
    return error.message.slice(0, 500)
  }
  return String(error).slice(0, 500)
}
