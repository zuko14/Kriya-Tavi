import type { Page } from "playwright-core"

import type { PageElement, Snapshot } from "./protocol"

// What the agent sees of a page (BROWSER_AND_LOGIN_PROFILES.md §3.1, T5):
// interactive elements, headings and readable text near the viewport, with
// short refs. Sensitive fields are marked and their values never read.

export const MAX_ELEMENTS = 120
const TEXT_CHARS = 4_000
const NAME_CHARS = 80

// Runs in the page. A plain string, so no build step can inject helpers
// into it. Refs live in a per-session random attribute.
const COLLECT = String.raw`(opts) => {
  const ROLES = new Set(["button","link","checkbox","radio","switch","tab","menuitem","option","combobox","textbox","searchbox","slider","heading"])
  const SENSITIVE = /(password|passcode|\botp\b|one[\s-]?time|verification code|cvv|cvc|\bpin\b|aadhaa?r|card number|आधार|पासवर्ड|ఆధార్|పాస్‌వర్డ్)/i
  const SENSITIVE_AUTOCOMPLETE = /(one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password)/i
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim()
  const labelText = (el) => {
    const aria = el.getAttribute("aria-label")
    if (aria) return aria
    const by = el.getAttribute("aria-labelledby")
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
      if (clean(t)) return t
    }
    if (el.labels && el.labels.length) {
      return Array.from(el.labels).map((label) => {
        const copy = label.cloneNode(true)
        copy.querySelectorAll("input,textarea,select").forEach((x) => x.remove())
        return copy.textContent
      }).join(" ")
    }
    return el.getAttribute("placeholder") || el.getAttribute("title") || ""
  }
  const isField = (el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"
  const sensitive = (el) => {
    if (!el || !isField(el)) return false
    if (el.type === "password") return true
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "")) return true
    return SENSITIVE.test([el.name, el.id, el.getAttribute("placeholder"), labelText(el)].join(" "))
  }
  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").split(" ")[0]
    if (explicit) return ROLES.has(explicit) ? explicit : null
    const tag = el.tagName
    if (tag === "A") return el.hasAttribute("href") ? "link" : null
    if (tag === "BUTTON" || tag === "SUMMARY") return "button"
    if (tag === "SELECT") return "combobox"
    if (tag === "TEXTAREA") return "textbox"
    if (/^H[1-3]$/.test(tag)) return "heading"
    if (el.isContentEditable) return "textbox"
    if (tag === "INPUT") {
      const t = el.type
      if (t === "hidden") return null
      if (["submit","button","reset","image","file"].includes(t)) return "button"
      if (t === "checkbox" || t === "radio") return t
      if (t === "range") return "slider"
      return "textbox"
    }
    return null
  }
  const nameOf = (el) => {
    let name = ""
    if (isField(el) && !["submit","button","reset","image"].includes(el.type)) name = labelText(el)
    else name = el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("title") || ""
    return clean(name).slice(0, opts.nameChars)
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const s = getComputedStyle(el)
    if (s.visibility === "hidden" || s.display === "none") return false
    return r.bottom > -innerHeight && r.top < 2 * innerHeight
  }
  const state = (window[opts.attr] = window[opts.attr] || { n: 0 })
  const elements = []
  const all = document.querySelectorAll('a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],h1,h2,h3')
  for (const el of all) {
    if (elements.length >= opts.max) break
    const role = roleOf(el)
    if (!role || !visible(el)) continue
    if (!el.hasAttribute(opts.attr)) el.setAttribute(opts.attr, "e" + ++state.n)
    const secret = sensitive(el)
    const item = { ref: el.getAttribute(opts.attr), role, name: nameOf(el), inForm: Boolean(el.form || el.closest("form")), sensitive: secret }
    // A button outside a form submits nothing, whatever its default type
    const type = el.tagName === "INPUT" || (el.tagName === "BUTTON" && el.form) ? el.type : el.getAttribute("type")
    if (type) item.type = String(type).toLowerCase()
    if (isField(el) && !secret && el.type !== "checkbox" && el.type !== "radio" && el.type !== "file" && el.value) item.value = String(el.value).slice(0, 200)
    if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.maxLength > 0) item.maxLength = el.maxLength
    if (el.disabled) item.disabled = true
    if (role === "link") item.href = String(el.href).slice(0, 200)
    elements.push(item)
  }
  const captcha = Boolean(document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],iframe[src*="arkoselabs"]'))
  const main = document.querySelector("main") || document.body
  const text = ((main && main.innerText) || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, opts.textChars)
  return {
    title: clean(document.title).slice(0, 200),
    url: location.href,
    elements,
    text,
    facts: { hasForm: document.forms.length > 0, focusedSensitive: sensitive(document.activeElement), captcha },
  }
}`

export type Collected = Pick<Snapshot, "title" | "elements" | "text"> & {
  url: string
  facts: Omit<Snapshot["facts"], "url" | "domain">
}

export async function collect(page: Page, attr: string): Promise<Collected> {
  const opts = { attr, max: MAX_ELEMENTS, textChars: TEXT_CHARS, nameChars: NAME_CHARS }
  return page.evaluate(`(${COLLECT})(${JSON.stringify(opts)})`) as Promise<Collected>
}

export const elementKey = (e: Pick<PageElement, "role" | "name">) =>
  `${e.role} "${e.name}"`

// Finished snapshot, with a diff when the page didn't navigate
export function toSnapshot(current: Collected, previous: Collected | null): Snapshot {
  const keys = current.elements.map(elementKey)
  const before = previous?.url === current.url ? previous.elements.map(elementKey) : null
  let host = ""
  try {
    host = new URL(current.url).hostname
  } catch {}
  return {
    title: current.title,
    elements: current.elements,
    text: current.text,
    // The worker's client turns the host into the registrable domain
    facts: { ...current.facts, url: current.url, domain: host },
    diff: before
      ? {
          added: keys.filter((key) => !before.includes(key)),
          removed: before.filter((key) => !keys.includes(key)),
        }
      : null,
  }
}
