// The wire contract between the worker and kriya-browser (BROWSER_AND_LOGIN_PROFILES.md
// §2.2, §3.1). Types and constants only: nothing from lib/; the
// worker re-exports these from lib/browser/provider.ts.

export type PageElement = {
  ref: string // short id, e12, valid until the next navigation
  role: string // link, button, textbox, checkbox, radio, combobox, heading…
  name: string // accessible name
  inForm: boolean
  // Password, OTP, card, PIN or Aadhaar field: its value is never read
  sensitive: boolean
  type?: string // the input or button type attribute
  value?: string // current value of a non-sensitive field
  disabled?: boolean
  checked?: boolean
  href?: string
  // The field's own length limit (maxlength), for kits (K9)
  maxLength?: number
}

// Computed by code; the policy engine decides from these, not from the model
export type PageFacts = {
  url: string
  domain: string // registrable domain of the page
  hasForm: boolean
  focusedSensitive: boolean
  captcha: boolean
}

export type PageView = { elements: PageElement[]; facts: PageFacts }

export type Snapshot = PageView & {
  title: string
  text: string // readable main text, capped; untrusted
  // Elements that appeared or went away since the last snapshot of the
  // same page; null after a navigation
  diff: { added: string[]; removed: string[] } | null
}

export type HandoffReason =
  "login" | "captcha" | "otp" | "password" | "payment" | "review" | "other"

// The model may say a step is a commit; that can only raise its class
type Intent = { intent?: "commit" }

export type BrowserAction =
  | { action: "open"; url: string }
  | { action: "snapshot" }
  | ({ action: "click"; ref: string } & Intent)
  | ({ action: "type"; ref: string; text: string } & Intent)
  | ({ action: "select"; ref: string; value: string } & Intent)
  // Always R4 (AT-BRW-10). The model names a kriya.files id; the worker
  // adds the bytes from that file, so nothing else can be uploaded
  | ({ action: "upload"; ref: string; fileId: string; file?: UploadFile } & Intent)
  | { action: "scroll"; direction: "up" | "down" }
  | { action: "screenshot" }
  | { action: "handoff"; reason: HandoffReason }
  | { action: "close" }

export type UploadFile = { name: string; mime: string; data: string } // base64

// Evidence of what the page looked like; the image itself is returned once
export type Screenshot = { sha256: string; bytes: number; png?: string }

export type ActionResult =
  | { ok: true; snapshot: Snapshot; screenshot?: Screenshot }
  | { ok: false; error: BrowserErrorCode; message: string; snapshot?: Snapshot }

export type BrowserErrorCode =
  | "blocked" // egress guard or policy refused
  | "sensitive" // a sensitive field or CAPTCHA is in the way
  | "not_found" // the ref isn't on the page any more
  | "rate_limited"
  | "stopped" // too many failures, too long, or closed
  | "paused" // handed off to the person
  // Set by the worker: a login profile's site shows its sign-in page (A6)
  | "login_required"
  | "failed"

export type OpenSession = {
  // The task, or "login:<profile id>" for a take-over sign-in
  taskId: string
  userId: string
  viewport?: { width: number; height: number }
  // A login profile's state (A6), only over the worker's private channel
  state?: StorageState
  // With a profile loaded: the only sites the main frame may navigate to
  // (a registrable domain also allows its subdomains)
  allowedDomains?: string[]
}

// Playwright's storage state: what a login profile keeps (AD-05). Never
// logged, never in a snapshot, never sent to the person's browser
export type StorageState = {
  cookies: {
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: "Strict" | "Lax" | "None"
  }[]
  origins: { origin: string; localStorage: { name: string; value: string }[] }[]
}

// Live view (take-over, BROWSER §5): JSON over the WebSocket. The person's
// browser sends taps, keys and text; the service sends JPEG frames that are
// shown and never stored.
export type LiveInput =
  | { t: "down" | "up" | "move"; x: number; y: number }
  | { t: "wheel"; x: number; y: number; dy: number }
  | { t: "text"; text: string }
  | { t: "key"; key: LiveKey }
  | { t: "ping" }
  // Gives control back to the agent and ends the live view
  | { t: "done" }

export const LIVE_KEYS = [
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
] as const
export type LiveKey = (typeof LIVE_KEYS)[number]

export type LiveOutput =
  | { t: "frame"; data: string; width: number; height: number } // base64 JPEG
  | { t: "page"; url: string }
  | { t: "ended"; reason: string }

export type PdfOptions = { format?: "A4" | "Letter"; landscape?: boolean }
