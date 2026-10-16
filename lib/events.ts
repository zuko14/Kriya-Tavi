// Things worth telling the person about, wherever they are in the app. The
// browser follows them over /api/events (built from the tasks table) and
// turns them into a sound, a browser notification and a notification card.

type Common = {
  threadId: string
  href: string
  // The agent the task was addressed to, and its glyph
  name: string
  glyph: string
}

export type KriyaEvent =
  | (Common & {
      // A task began: a page showing the thread follows it live
      type: "turn-started"
    })
  | (Common & {
      type: "turn-finished"
      preview: string
      ok: boolean
      error?: string
      durationMs: number
    })

// A reply's Markdown as one clean line of text for a notification
export function previewText(markdown: string, max = 240) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    // A table's header row and the rule under it
    .replace(/^[ \t]*\|.*\|[ \t]*\r?\n[ \t]*\|?[ \t]*:?-{3,}.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(
      /^[ \t]*\|(.*)\|[ \t]*$/gm,
      (_, row: string) =>
        `${row
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(" · ")};`
    )
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}
