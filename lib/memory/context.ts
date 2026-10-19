import type { Note } from "@/lib/memory/retrieve"

// The memory part of the prompt, as budgeted blocks in a fixed order
// (MEMORY_AND_CONTEXT.md §5, AD-12): what changes rarely first, so providers
// can cache the prefix, and the date after it, so a new day doesn't break the
// cache. Pure: the caller loads the notes (lib/memory/retrieve.ts).

// Tokens per block, estimated as characters ÷ 4 (no tokenizer dependency).
// Changed only through the governed improvement loop (AD-25).
export const BUDGETS = {
  identity: 2_000,
  profile: 500,
  standing: 600,
  now: 60,
  goals: 300,
  recalled: 800,
  episodes: 400,
  summary: 800,
} as const

export type BlockName = keyof typeof BUDGETS

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export type ContextInput = {
  // Block 1, built by lib/agent/instructions.ts. Not cut: it holds the
  // person's standing orders.
  identity: string
  profile: Note[]
  // Newest first
  standing: Note[]
  // Best first
  recalled: Note[]
  now: Date
  locale: string
  goals?: string[]
  episodes?: string[]
  summary?: string | null
}

export type ContextBlock = { name: BlockName; text: string; ids: string[] }

const HEADINGS: Record<Exclude<BlockName, "identity">, string> = {
  profile: "# About the person",
  standing: "# The person's standing preferences and instructions",
  now: "# Now",
  goals: "# Active goals",
  recalled: "# Notes that may help with this message",
  episodes: "# What you did before",
  summary: "# Earlier in this thread (summary)",
}

const marks = (note: Note) =>
  `${note.source === "user" ? " (from the person)" : ""}${
    note.trust === "unconfirmed" ? " (unconfirmed)" : ""
  }`

const noteLine = (note: Note) => `- [${note.id}]${marks(note)} ${note.content}`
const profileLine = (note: Note) =>
  `- [${note.id}]${marks(note)} ${note.slot!.replace(/^profile\./, "")}: ${note.content}`

// Heading plus as many lines as fit, in the order given
function pack(name: Exclude<BlockName, "identity">, lines: [string, string?][]) {
  const limit = BUDGETS[name] * 4
  let text = HEADINGS[name]
  const ids: string[] = []
  for (const [line, id] of lines) {
    if (text.length + 1 + line.length > limit) break
    text += `\n${line}`
    if (id) ids.push(id)
  }
  return text === HEADINGS[name] ? null : { name, text, ids }
}

function nowBlock(now: Date, locale: string): ContextBlock {
  const when = new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now)
  return { name: "now", text: `${HEADINGS.now}\n${when} IST`, ids: [] }
}

export function assembleContext(input: ContextInput) {
  const shown = new Set([...input.profile, ...input.standing].map((note) => note.id))
  const summaryLimit = BUDGETS.summary * 4 - HEADINGS.summary.length - 2
  const summary = input.summary?.trim()

  const blocks = [
    { name: "identity" as const, text: input.identity, ids: [] },
    pack(
      "profile",
      input.profile.map((note) => [profileLine(note), note.id])
    ),
    pack(
      "standing",
      input.standing.map((note) => [noteLine(note), note.id])
    ),
    nowBlock(input.now, input.locale),
    pack(
      "goals",
      (input.goals ?? []).map((goal) => [`- ${goal}`])
    ),
    pack(
      "recalled",
      input.recalled
        .filter((note) => !shown.has(note.id))
        .map((note) => [noteLine(note), note.id])
    ),
    pack(
      "episodes",
      (input.episodes ?? []).map((episode) => [`- ${episode}`])
    ),
    summary
      ? {
          name: "summary" as const,
          text: `${HEADINGS.summary}\n${
            summary.length > summaryLimit
              ? `${summary.slice(0, summaryLimit - 1)}…`
              : summary
          }`,
          ids: [],
        }
      : null,
  ].filter((block): block is ContextBlock => block !== null)

  return {
    blocks,
    // What the reply's "Used N memories" chip lists (§5.2)
    memoryIds: blocks.flatMap((block) => block.ids),
    text: blocks.map((block) => block.text).join("\n\n"),
  }
}
