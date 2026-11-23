import { TOOL_CLASSES } from "@/lib/agent/policy"
import { CartridgeFile, type Cartridge } from "@/lib/harness/cartridges"

// Harness 2.0 W9: lintCartridge, the E3 guard on every candidate
// (docs/kriya-harness/upgrade_2.0/SELF_EVOLUTION.md §7, §2.5). Pure. A
// candidate is refused if any rule fails. Deliberately over-strict: a refused
// good idea costs a missed improvement, an accepted bad one could reach every
// device. Only what the candidate adds or changes is judged (REAUDIT RA-31):
// the base text of some cartridges legitimately says "token" or "secret".

export type CartridgeText = {
  // SKILL.md without its front matter
  body: string
  cartridge: Cartridge
  // kriya.json
  manifest: Record<string, unknown>
}

export const BOUNDS = {
  maxBodyChars: 6000,
  maxChangedRatio: 0.3,
  maxJudgement: 12,
} as const

export const LINT_RULES = [
  {
    rule: 1,
    id: "fields",
    label: "Changes only the body, judgement, added gates and detectors, and keywords",
  },
  {
    rule: 2,
    id: "protected",
    label:
      "Removes no gate or detector; role, owns, reads, escalateAfter, maxPromptChars unchanged",
  },
  {
    rule: 3,
    id: "content",
    label:
      "Added lines hold no URL, shell block, banned word, tool name or protected path",
  },
  {
    rule: 4,
    id: "licence",
    label: "Names no font, asset or code source without an allowed licence",
  },
  { rule: 5, id: "size", label: "Within the size bounds" },
] as const

export type LintResult = {
  ok: boolean
  rules: { rule: number; id: string; label: string; ok: boolean; problems: string[] }[]
  changedLines: number
  baseLines: number
}

/* ─────────────────────────────── diff ─────────────────────────────── */

export type DiffLine = { op: " " | "+" | "-"; text: string }

/** A line diff (longest common subsequence); bodies are small, so O(n·m) is fine. */
export function lineDiff(base: string, next: string): DiffLine[] {
  const a = base.split("\n")
  const b = next.split("\n")
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: " ", text: a[i] })
      i++
      j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j]))
      out.push({ op: "+", text: b[j++] })
    else out.push({ op: "-", text: a[i++] })
  }
  return out
}

export const diffText = (lines: DiffLine[]) => lines.map((l) => l.op + l.text).join("\n")

/* ────────────────────────────── content ───────────────────────────── */

// Whole words, case-insensitive; a plural counts too
const BANNED_WORDS = [
  "curl",
  "wget",
  "sudo",
  "chmod",
  "rm -rf",
  "eval(",
  "password",
  "api key",
  "token",
  "sandbox",
  "approval",
  "full access",
  "--mode",
  "ignore previous",
  "system prompt",
]

// DSH's own tools (the client's catalogue, by the names the loop masks) and
// the client's kriya_* tools; Kriya's are TOOL_CLASSES
const DSH_TOOLS = [
  "bash",
  "pwsh",
  "str_replace_editor",
  "todo_write",
  "web_fetch",
  "web_search",
  "ask_user",
  "subagent",
  "spawn",
]
export const TOOL_NAMES = [...new Set([...DSH_TOOLS, ...Object.keys(TOOL_CLASSES)])]

// E3: what never changes by itself (SELF_EVOLUTION §1; HARNESS 2.0 CHANGE_IMPACT §1)
const E3_PATHS =
  /lib\/agent\/|lib\/auth\.ts|lib\/harness\/(?:gateway|metering)\.ts|lib\/harness\/evolve\/gate\.ts|lib\/connectors|lib\/memory\/|lib\/browser\/|egress|src\/(?:modes|verify|loop|checkpoints)\.js|cordis\.patch\.yml|\bMAX_STEPS\b|\bMAX_ATTEMPTS\b|\bREQUIRED\b|\bTOOL_CLASSES\b|\bTOOL_APPROVALS\b|policy\.ts/

const URL_RE = /\b(?:https?|ftp|file|wss?):\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i
const SHELL_FENCE =
  /^\s*(?:```|~~~)\s*(?:sh|bash|zsh|shell|powershell|pwsh|cmd|console|bat|ps1)\b/i

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const word = (term: string) =>
  new RegExp(
    (/^\w/.test(term) ? "(?<![\\w-])" : "") +
      escape(term) +
      (/\w$/.test(term) ? "s?(?![\\w])" : ""),
    "i"
  )
const WORD_RES = BANNED_WORDS.map((t) => [t, word(t)] as const)
const TOOL_RES = [
  ...TOOL_NAMES.map((t) => [t, word(t)] as const),
  ["kriya_*", /\bkriya_[a-z_]+\b/i] as const,
]

/** Every rule-3 problem in one added or changed text. */
export function contentProblems(text: string): string[] {
  const out: string[] = []
  if (URL_RE.test(text)) out.push("a URL")
  if (SHELL_FENCE.test(text)) out.push("a shell code block")
  for (const [t, re] of WORD_RES) if (re.test(text)) out.push(`the word "${t}"`)
  for (const [t, re] of TOOL_RES) if (re.test(text)) out.push(`the tool name "${t}"`)
  if (E3_PATHS.test(text)) out.push("a protected path or constant")
  return out
}

// Track E rule 8's licence table (SKILLS_AND_OPEN_SOURCE §2)
const NAMES_SOURCE =
  /\b(?:fonts?|typefaces?|icon (?:sets?|packs?)|stock (?:images?|photos?)|sound effects?|music|vendored|copied from|(?:code|snippets?|templates?|assets?) (?:from|copied))\b/i
const ALLOWED_LICENCE =
  /\b(?:MIT|BSD(?:-[23]-Clause)?|ISC|Apache-2\.0|Unlicense|CC0|OFL|SIL Open Font)\b/
const REFUSED_LICENCE =
  /\b(?:A?GPL|CC BY-NC|PolyForm|non-commercial|noncommercial|all rights reserved|Remotion|GSAP)\b/i

export function licenceProblems(text: string): string[] {
  if (REFUSED_LICENCE.test(text)) return ["a licence outside the allowed list"]
  if (NAMES_SOURCE.test(text) && !ALLOWED_LICENCE.test(text))
    return ["a font, asset or code source without an allowed licence"]
  return []
}

/* ─────────────────────────────── lint ─────────────────────────────── */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const PROTECTED = ["role", "owns", "reads", "escalateAfter", "maxPromptChars"] as const
const EDITABLE = new Set(["judgement", "gates", "detectors", ...PROTECTED])

/**
 * Lints a candidate against the incumbent it replaces.
 * @returns every rule with its problems, so the owner page can show all of them
 */
export function lintCartridge(base: CartridgeText, next: CartridgeText): LintResult {
  const problems: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] }

  // 1. Fields: the cartridge block must still be a valid one (gate and
  // detector ids from the client catalogue); nothing else may change
  const parsed = CartridgeFile.safeParse(next.cartridge)
  if (!parsed.success)
    problems[1].push("the cartridge block isn't valid (an unknown gate or detector id?)")
  const keys = new Set([...Object.keys(base.cartridge), ...Object.keys(next.cartridge)])
  for (const k of keys)
    if (
      !EDITABLE.has(k) &&
      !same(base.cartridge[k as keyof Cartridge], next.cartridge[k as keyof Cartridge])
    )
      problems[1].push(`the cartridge field "${k}" changed`)
  const { activation: baseActivation, ...baseRest } = base.manifest
  const { activation: nextActivation, ...nextRest } = next.manifest
  for (const k of new Set([...Object.keys(baseRest), ...Object.keys(nextRest)]))
    if (!same(baseRest[k], nextRest[k]))
      problems[1].push(`the manifest field "${k}" changed`)
  const ba = (baseActivation ?? {}) as Record<string, unknown>
  const na = (nextActivation ?? {}) as Record<string, unknown>
  for (const k of new Set([...Object.keys(ba), ...Object.keys(na)]))
    if (k !== "keywords" && !same(ba[k], na[k]))
      problems[1].push(`the activation field "${k}" changed`)
  const baseKeywords = (ba.keywords as string[] | undefined) ?? []
  const nextKeywords = (na.keywords as string[] | undefined) ?? []
  if (baseKeywords.some((k) => !nextKeywords.includes(k)))
    problems[1].push("a keyword was removed")

  // 2. Protected: nothing removed, nothing that shapes the role changed
  for (const g of base.cartridge.gates)
    if (!next.cartridge.gates?.includes(g)) problems[2].push(`the gate ${g} was removed`)
  for (const d of base.cartridge.detectors) {
    const now = next.cartridge.detectors?.find((x) => x.id === d.id)
    if (!now) problems[2].push(`the detector ${d.id} was removed`)
    else if (now.severity !== d.severity)
      problems[2].push(`the detector ${d.id} changed severity`)
  }
  for (const k of PROTECTED)
    if (!same(base.cartridge[k], next.cartridge[k])) problems[2].push(`"${k}" changed`)

  // 3 and 4. What the candidate adds: changed body lines, new or changed
  // judgement items, new keywords
  const diff = lineDiff(base.body, next.body)
  const added = diff.filter((l) => l.op === "+").map((l) => l.text)
  const baseAsks = new Map(base.cartridge.judgement.map((j) => [j.id, j.ask]))
  for (const j of next.cartridge.judgement ?? [])
    if (baseAsks.get(j.id) !== j.ask) added.push(j.id, j.ask)
  added.push(...nextKeywords.filter((k) => !baseKeywords.includes(k)))
  // A fence's tag is on its own line: judge the added text line by line and whole
  for (const text of [...added, added.join("\n")]) {
    for (const p of contentProblems(text))
      if (!problems[3].includes(p)) problems[3].push(p)
    for (const p of licenceProblems(text))
      if (!problems[4].includes(p)) problems[4].push(p)
  }

  // 5. Size
  const changedLines = diff.filter((l) => l.op !== " " && l.text.trim()).length
  const baseLines = Math.max(1, base.body.split("\n").filter((l) => l.trim()).length)
  if (next.body.length > BOUNDS.maxBodyChars)
    problems[5].push(
      `the body is ${next.body.length} characters (at most ${BOUNDS.maxBodyChars})`
    )
  if (next.body.length > base.cartridge.maxPromptChars)
    problems[5].push(
      `the body is over the cartridge's ${base.cartridge.maxPromptChars} characters`
    )
  if (changedLines / baseLines > BOUNDS.maxChangedRatio)
    problems[5].push(
      `${changedLines} lines changed of ${baseLines} (at most ${Math.round(BOUNDS.maxChangedRatio * 100)}%)`
    )
  if ((next.cartridge.judgement?.length ?? 0) > BOUNDS.maxJudgement)
    problems[5].push(`more than ${BOUNDS.maxJudgement} judgement items`)
  if (!next.body.trim()) problems[5].push("the body is empty")

  const rules = LINT_RULES.map((r) => ({
    ...r,
    ok: problems[r.rule].length === 0,
    problems: problems[r.rule],
  }))
  return { ok: rules.every((r) => r.ok), rules, changedLines, baseLines }
}
