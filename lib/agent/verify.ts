import { z } from "zod"

import type { CitationCheck, EpisodeClaim, Verification } from "@/db/schema"

// The verifier (ARCHITECTURE §2.3). The reply's prose is never evidence:
// an action counts only when a tool ran it and checked it (AD-02), and a
// quoted source must hold the quote word for word (K7, AD-33). Nothing here
// rewrites the reply; it only marks it. Pure, so the worker and tests share it.

const verificationSchema = z.object({
  status: z.enum(["verified", "unverified", "failed"]),
  method: z.enum(["api_readback", "page_check", "file", "none"]),
  evidence: z.array(
    z.object({ kind: z.enum(["file", "url", "provider_id"]), value: z.string() })
  ),
  note: z.string().optional(),
})

// The `verification` an R2–R4 tool returned, if it's well formed
export function verificationOf(output: unknown): Verification | null {
  const parsed = verificationSchema.safeParse(
    (output as { verification?: unknown } | null)?.verification
  )
  return parsed.success ? parsed.data : null
}

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

/* ───────────────────────────── claims ───────────────────────────── */

const I_DID = String.raw`\bI(?:'ve| have)? (?:just |already )?`
const CLAIMS: { pattern: RegExp; tools: string[] | null; onlyIfRan?: boolean }[] = [
  // G2 (OD-16): "sent" or "emailed" is backed by a sent draft; with none sent, the row below answers as before
  {
    pattern: new RegExp(`${I_DID}(?:sent|emailed|mailed)\\b`, "i"),
    tools: ["gmail_send_draft"],
    onlyIfRan: true,
  },
  // Nothing else in Kriya sends or posts, so these are never backed
  {
    pattern: new RegExp(
      `${I_DID}(?:sent|emailed|mailed|messaged|posted|published|submitted|applied)\\b`,
      "i"
    ),
    tools: null,
  },
  {
    pattern: new RegExp(
      `${I_DID}(?:added|booked|put|created|scheduled)\\b.*\\b(?:calendar|event|meeting|invite)`,
      "i"
    ),
    tools: ["calendar_create_event"],
  },
  {
    pattern: new RegExp(
      `${I_DID}(?:deleted|removed|cancelled|canceled)\\b.*\\b(?:calendar|event|meeting|invite)`,
      "i"
    ),
    tools: ["calendar_delete_event"],
  },
  {
    pattern: new RegExp(
      `${I_DID}(?:drafted|saved (?:a|an|the|your) (?:draft|email|reply))`,
      "i"
    ),
    tools: ["gmail_draft"],
  },
  {
    pattern: new RegExp(
      `${I_DID}(?:set up|created|scheduled|added)\\b.*\\b(?:schedule|weekly|daily|monthly|every (?:day|week|month|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday))`,
      "i"
    ),
    tools: ["schedule_create"],
  },
  {
    pattern: new RegExp(`${I_DID}(?:created|set up|started)\\b.*\\bgoal\\b`, "i"),
    tools: ["goal_create"],
  },
  {
    pattern: new RegExp(
      `${I_DID}(?:noted|remembered|saved (?:that|this|it) (?:to |in )?(?:my )?memory)`,
      "i"
    ),
    tools: ["memory_write", "memory_update"],
  },
]

// Sentences in the reply that say an action happened, with no successful
// run of a tool that does it (AT-VER-02). ponytail: an English lexicon of
// first-person past tense; Hindi and Telugu claims pass unmarked until
// AS-XCK shows they need patterns.
export function unconfirmedClaims(
  reply: string,
  executions: { tool: string; status: string }[]
): EpisodeClaim[] {
  const ran = new Set(
    executions.filter((e) => e.status === "succeeded").map((e) => e.tool)
  )
  const claims: EpisodeClaim[] = []
  for (const sentence of sentences(reply.replace(/[‘’]/g, "'"))) {
    const match = CLAIMS.find(
      (c) =>
        c.pattern.test(sentence) &&
        (!c.onlyIfRan || c.tools!.some((tool) => ran.has(tool)))
    )
    if (!match) continue
    if (!match.tools) {
      claims.push({
        claim: sentence.slice(0, 200),
        reason: "Kriya can't send email or post; at most a draft was saved.",
      })
    } else if (!match.tools.some((tool) => ran.has(tool))) {
      claims.push({ claim: sentence.slice(0, 200), reason: "No matching action ran." })
    }
  }
  return claims
}

/* ───────────────────────────── citations ────────────────────────── */

// Tools whose output can be quoted
const SOURCE_TOOLS = new Set([
  "web_fetch",
  "drive_read",
  "gmail_read",
  "notion_read",
  "file_read",
  "facts_lookup",
  "browser_open",
  "browser_snapshot",
])

const leaves = (value: unknown, key = ""): string[] => {
  if (key === "notice") return []
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap((v) => leaves(v))
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => leaves(v, k))
  return []
}

// The text of each reading tool's output in the reply, in call order:
// source [1] is the first. Saved message parts keep outputs whole.
export function sourceTexts(
  parts: { type: string; output?: unknown; [key: string]: unknown }[]
) {
  return parts
    .filter((p) => p.type.startsWith("tool-") && SOURCE_TOOLS.has(p.type.slice(5)))
    .filter((p) => p.output != null)
    .map((p) => leaves(p.output).join("\n"))
}

const normalise = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()

const MARK = /\[(\d{1,2})\]/g
const QUOTE = /["“”]([^"“”]{2,})["“”]/g
// Money and deadlines are the claims that must carry a source
const FLAGGED =
  /₹\s?\d|\bRs\.?\s?\d|\bINR\s?\d|\b(?:last date|deadline|due (?:date|on|by)|closes on|apply by)\b|अंतिम तिथि|आखिरी तारीख/i

// Each sentence with a citation, or with an uncited ₹ amount or deadline
// when the reply drew on sources, checked against those sources word for
// word (AT-XCK-01). The person's own numbers, with nothing read, pass.
export function checkCitations(reply: string, sources: string[]): CitationCheck[] {
  const checks: CitationCheck[] = []
  for (const sentence of sentences(reply)) {
    const marks = [...sentence.matchAll(MARK)]
    if (marks.length === 0) {
      if (sources.length > 0 && FLAGGED.test(sentence)) {
        checks.push({
          sentence: sentence.slice(0, 300),
          status: "unsupported",
          reason: "No citation for a money or deadline claim.",
        })
      }
      continue
    }
    const quotes = [...sentence.matchAll(QUOTE)]
    let reason: string | undefined
    for (const mark of marks) {
      const n = Number(mark[1])
      const quote = quotes
        .filter((q) => q.index! + q[0].length <= mark.index!)
        .at(-1)?.[1]
      const source = sources[n - 1]
      if (source === undefined) reason = `Source ${n} doesn't exist.`
      else if (!quote) reason = `No quote for source ${n}.`
      else if (!normalise(source).includes(normalise(quote)))
        reason = `Quote not found in source ${n}.`
      if (reason) break
    }
    checks.push({
      sentence: sentence.slice(0, 300),
      status: reason ? "unsupported" : "supported",
      ...(reason && { reason }),
    })
  }
  return checks
}
