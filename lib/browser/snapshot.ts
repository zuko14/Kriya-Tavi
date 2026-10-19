import type { Snapshot } from "@/lib/browser/provider"

// A snapshot as the model reads it (MEMORY_AND_CONTEXT.md T5): one line per
// element, then the page text. Never over the budget; after a step that
// didn't navigate, the diff alone is usually enough.

// Proposed in A4 (no figure in the blueprint): 120 elements and 4,000
// characters of page text fit with room to spare
export const SNAPSHOT_TOKEN_BUDGET = 3_000

export function renderSnapshot(snapshot: Snapshot, { diffOnly = false } = {}) {
  const { facts } = snapshot
  const flags = [
    facts.captcha && "CAPTCHA on the page: hand off",
    facts.focusedSensitive && "a sensitive field is focused: hand off",
  ].filter(Boolean)
  const head = [`${snapshot.title} (${facts.url})`, ...flags].join("\n")
  if (diffOnly && snapshot.diff) {
    const { added, removed } = snapshot.diff
    return [
      head,
      "Changed since your last look:",
      ...added.map((line) => `+ ${line}`),
      ...removed.map((line) => `- ${line}`),
    ]
      .join("\n")
      .slice(0, SNAPSHOT_TOKEN_BUDGET * 4)
  }
  const lines = snapshot.elements.map((e) => {
    const extras = [
      e.inForm && "in form",
      e.sensitive && "sensitive: the person types this",
      e.checked && "checked",
      e.disabled && "disabled",
      e.maxLength && `max ${e.maxLength} characters`,
    ].filter(Boolean)
    const value = e.value ? ` = "${e.value}"` : ""
    return `${e.ref} ${e.role} "${e.name}"${value}${extras.length ? ` [${extras.join(", ")}]` : ""}`
  })
  return [head, ...lines, "Page text:", snapshot.text]
    .join("\n")
    .slice(0, SNAPSHOT_TOKEN_BUDGET * 4)
}
