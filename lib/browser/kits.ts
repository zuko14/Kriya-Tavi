import type { KitField } from "@/db/schema"
import type { PageView } from "@/lib/browser/provider"

// Ready-to-apply kits (K9, AD-35): on sites where agents may not press Save
// or Submit, the agent prepares the exact text and the person applies it.
// Limits come from the page itself at run time, never from the model; a kit
// counts as applied only when the public page shows its text. Pure.

const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase()

// The page's field for a kit field: a text box whose label matches
function fieldFor(page: PageView, label: string) {
  const want = norm(label)
  return page.elements.find(
    (e) => (e.role === "textbox" || e.role === "searchbox") && norm(e.name) === want
  )
}

export type Fitted =
  | { ok: true; fields: KitField[]; limitsRead: boolean }
  | { ok: false; problems: string[] }

// AT-KIT-01: every field within the limit its page declares. `page` is the
// deep link as the browser read it just now, or null when there is no
// browser (limits then unknown, and the kit says so).
export function fitKit(
  fields: { label: string; text: string }[],
  page: PageView | null
): Fitted {
  const problems: string[] = []
  const fitted = fields.map(({ label, text }) => {
    const limit = page ? (fieldFor(page, label)?.maxLength ?? null) : null
    // maxlength counts UTF-16 code units, as String.length does
    if (limit !== null && text.length > limit) {
      problems.push(
        `"${label}" is ${text.length} characters; the site allows ${limit}. Shorten it.`
      )
    }
    return { label, text, limit }
  })
  return problems.length
    ? { ok: false, problems }
    : { ok: true, fields: fitted, limitsRead: page !== null }
}

// AT-KIT-02: verified only when the page shows every field's text
export function checkKit(fields: KitField[], pageText: string) {
  const page = norm(pageText)
  return fields.every((field) => page.includes(norm(field.text)))
    ? ("verified" as const)
    : ("unverified" as const)
}
