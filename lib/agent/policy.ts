import type { BrowserAction, PageElement, PageView } from "@/lib/browser/provider"
import { registrableDomain, type SiteRule } from "@/lib/browser/sites"

// Risk classes (AD-03), decided here and nowhere else. Pure and synchronous:
// the model's words never lower a class; page facts, site rules and the
// tool table decide.

export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4" | "R5"
export type Gate = "none" | "user-approval" | "refuse"

const ORDER: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5"]
const raise = (a: RiskClass, b: RiskClass) =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b

export function approvalFor(cls: RiskClass): Gate {
  if (cls === "R5") return "refuse"
  return cls === "R0" || cls === "R1" ? "none" : "user-approval"
}

// Accessible names that mean "this click changes something outside Kriya".
// English, Hindi and Telugu (BROWSER_AND_LOGIN_PROFILES.md §3.3).
const COMMIT_WORDS = [
  "save",
  "submit",
  "post",
  "publish",
  "send",
  "apply",
  "confirm",
  "pay",
  "buy",
  "order",
  "delete",
  "remove",
  "connect",
  "follow",
  "accept",
  "agree",
  "upload",
  "update profile",
  // Social actions: never automatic (AD-06, no fake engagement)
  "like",
  "share",
  "repost",
  "comment",
  "reply",
  "subscribe",
  "join",
  "endorse",
  "vote",
  "sign up",
  "register",
  "सहेजें",
  "सेव",
  "भेजें",
  "सबमिट",
  "जमा करें",
  "प्रकाशित",
  "पोस्ट",
  "आवेदन",
  "पुष्टि",
  "भुगतान",
  "खरीदें",
  "ऑर्डर",
  "हटाएं",
  "हटाएँ",
  "कनेक्ट",
  "फॉलो",
  "फ़ॉलो",
  "स्वीकार",
  "सहमत",
  "अपलोड",
  "సేవ్",
  "పంపు",
  "పంపండి",
  "సమర్పించు",
  "సమర్పించండి",
  "ప్రచురించు",
  "పోస్ట్",
  "దరఖాస్తు",
  "నిర్ధారించు",
  "చెల్లించు",
  "కొనండి",
  "ఆర్డర్",
  "తొలగించు",
  "కనెక్ట్",
  "ఫాలో",
  "అంగీకరించు",
  "అప్‌లోడ్",
]

// Whole words only, in any script (\b is ASCII-only in JavaScript)
const wordsPattern = (words: string[]) =>
  new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{M}\\p{N}])`,
    "iu"
  )
const COMMIT = wordsPattern(COMMIT_WORDS)

const FILL_ROLES = new Set([
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "option",
  "slider",
])

function isCommit(element: PageElement, site: SiteRule | null) {
  if (element.type === "submit") return true
  if (COMMIT.test(element.name)) return true
  return Boolean(
    site?.commitPatterns?.length && wordsPattern(site.commitPatterns).test(element.name)
  )
}

// A login profile loaded in the session (A6): the sites it belongs to
export type LoadedProfile = { domains: string[] } | null

const inside = (domain: string, profile: NonNullable<LoadedProfile>) =>
  profile.domains.some((d) => domain === d || domain.endsWith(`.${d}`))

function targetDomain(url: string) {
  try {
    return registrableDomain(new URL(url).hostname)
  } catch {
    return ""
  }
}

export function classifyBrowserAction(
  action: BrowserAction,
  page: PageView,
  site: SiteRule | null,
  profile: LoadedProfile = null
): RiskClass {
  if (
    action.action === "handoff" ||
    action.action === "snapshot" ||
    action.action === "close"
  )
    return "R0"
  // The person has to do this step themselves
  if (page.facts.focusedSensitive || page.facts.captcha) return "R5"
  // Signed in as the person: leaving their site could carry what's on the
  // page elsewhere (AT-BRW-08), so it needs approval
  if (action.action === "open") {
    return profile && !inside(targetDomain(action.url), profile) ? "R3" : "R0"
  }
  if (action.action === "scroll" || action.action === "screenshot") return "R0"

  const element = page.elements.find((e) => e.ref === action.ref)
  // Can't tell what it is: treat it as the most consequential click
  if (!element) return "R4"
  let cls: RiskClass
  if (element.sensitive) cls = "R5"
  // Sending a file to a site is always a commit (AT-BRW-10)
  else if (action.action === "upload") cls = "R4"
  // Typing on another site while signed in may send private content there
  else if (action.action !== "click" && profile && !inside(page.facts.domain, profile))
    cls = "R4"
  else if (action.action !== "click") cls = "R3"
  else if (isCommit(element, site)) cls = "R4"
  else cls = FILL_ROLES.has(element.role) ? "R3" : "R0"
  return action.intent === "commit" ? raise(cls, "R4") : cls
}

const HANDOFF =
  "The person has to do this step: call browser_handoff with the reason (login, captcha, otp, password, payment)."

function refusal(site: SiteRule | null) {
  switch (site?.mode) {
    case "assisted":
      return "This site is in assisted mode: Kriya doesn't fill or submit here. Prepare the exact text and call browser_handoff with reason review, so the person applies it."
    case "api":
      return "This site has an official connector; the browser only reads its public pages."
    default:
      return "Kriya hasn't reviewed this site's terms, so the browser only reads here. Prepare the text and call browser_handoff with reason review."
  }
}

export function browserDecision(
  action: BrowserAction,
  page: PageView,
  site: SiteRule | null,
  profile: LoadedProfile = null
): { cls: RiskClass; gate: Gate; reason?: string } {
  const cls = classifyBrowserAction(action, page, site, profile)
  if (action.action === "open" && cls === "R3") {
    return {
      cls,
      gate: "refuse",
      reason:
        "You're signed in to this site as the person, so Kriya's browser stays on it. Tell the person what you'd open and why.",
    }
  }
  if (action.action === "close") return { cls, gate: "none" }
  if (site?.mode === "blocked") {
    return { cls, gate: "refuse", reason: "Kriya doesn't use the browser on this site." }
  }
  const gate = approvalFor(cls)
  if (gate === "refuse") return { cls, gate, reason: HANDOFF }
  if (gate === "user-approval" && site?.mode !== "supervised") {
    return { cls, gate: "refuse", reason: refusal(site) }
  }
  return { cls, gate }
}

/* ───────────────────────────── tools ────────────────────────────── */

// Each tool's class (TOOLS_AND_CONTRACTS §2). Browser tools are R0 here
// because every browser step is classified again from the page, above.
// A tool missing from this table is R5: refused.
export const TOOL_CLASSES: Record<string, RiskClass> = {
  memory_write: "R1",
  memory_update: "R1",
  memory_forget: "R1",
  memory_search: "R0",
  web_search: "R0",
  web_fetch: "R0",
  browser_open: "R0",
  browser_snapshot: "R0",
  browser_click: "R0",
  browser_scroll: "R0",
  browser_handoff: "R0",
  browser_close: "R0",
  calendar_events: "R0",
  calendar_create_event: "R3",
  gmail_search: "R0",
  gmail_read: "R0",
  gmail_draft: "R3",
  drive_search: "R0",
  drive_read: "R0",
  notion_search: "R0",
  notion_read: "R0",
  delegate: "R0",
  assign: "R0",
  goal_create: "R1",
  goal_update: "R1",
  // Spends money later (each run is a task)
  schedule_create: "R2",
  schedule_update: "R1",
  // A8 connectors (TOOLS_AND_CONTRACTS §2.6): public actions as the person
  // are R4, edits to their own sheets R3
  github_search: "R0",
  github_read_issue: "R0",
  github_read_pr: "R0",
  github_comment: "R4",
  github_create_issue: "R4",
  github_label: "R4",
  github_open_pr: "R4",
  sheets_read: "R0",
  sheets_append: "R3",
  sheets_update: "R3",
  youtube_stats: "R0",
  instagram_insights: "R0",
  instagram_publish: "R4",
  // A9: a run executes only steps that need no approval and hands back the
  // rest, each re-classified (lib/skills.ts); saving makes a draft
  skill_propose: "R1",
  skill_list: "R0",
  skill_run: "R1",
  // A7: drafts only; confirming and issuing are the person's (AD-16, AD-17)
  ledger_list: "R0",
  ledger_draft_entry: "R1",
  invoice_draft: "R1",
  // A13: reading facts and the Radar, adding a quoted deadline
  facts_lookup: "R0",
  obligation_add: "R1",
  obligation_list: "R0",
  // A6 (K9): a kit is text for the person to apply; the check only reads
  kit_prepare: "R1",
  kit_check: "R0",
}

export function classifyTool(name: string, input: unknown): RiskClass {
  // Pausing or ending costs nothing; a new rule is a new commitment
  if (name === "schedule_update") return (input as { rule?: unknown })?.rule ? "R2" : "R1"
  return TOOL_CLASSES[name] ?? "R5"
}

// What each tool changes in Kriya's own tables (AT-POL-07): "table+" inserts
// rows, "table-" deletes them, "table.column" changes existing rows, with
// the values it can set after a colon. Kept by hand next to the classes,
// and checked against PERSON_ONLY_WRITES by tests/agent/tool-policy.test.ts.
export const TOOL_WRITES: Record<string, string[]> = {
  memory_write: [
    "memories+",
    "memories.invalid_at",
    "memories.superseded_by",
    "memories.last_used_at",
  ],
  memory_update: ["memories+", "memories.invalid_at", "memories.superseded_by"],
  memory_forget: ["memories-", "memories.invalid_at"],
  memory_search: [],
  web_search: [],
  web_fetch: [],
  // With a login profile (A6): used, or found signed out and expired
  browser_open: [
    "browser_sessions+",
    "resource_usage+",
    "login_profiles.last_used_at",
    "login_profiles.status:expired",
    "login_profiles.state_sealed",
  ],
  browser_snapshot: ["browser_sessions+", "resource_usage+"],
  browser_click: ["browser_sessions+", "resource_usage+"],
  browser_scroll: ["browser_sessions+", "resource_usage+"],
  browser_handoff: ["browser_sessions+", "resource_usage+"],
  // Refreshes a loaded login profile's state (active → active)
  browser_close: [
    "browser_sessions.status:closed",
    "resource_usage+",
    "login_profiles.state_sealed",
  ],
  calendar_events: [],
  calendar_create_event: [],
  gmail_search: [],
  gmail_read: [],
  gmail_draft: [],
  drive_search: [],
  drive_read: [],
  notion_search: [],
  notion_read: [],
  delegate: [],
  assign: [],
  goal_create: ["threads+", "goals+"],
  goal_update: ["goals.plan", "goals.status:achieved|paused", "goals.closed_at"],
  schedule_create: ["schedules+"],
  schedule_update: [
    "schedules.status:paused|ended",
    "schedules.pause_reason",
    "schedules.rule",
    "schedules.next_run_at",
  ],
  // A8: they change the person's outside accounts, not Kriya's tables
  github_search: [],
  github_read_issue: [],
  github_read_pr: [],
  github_comment: [],
  github_create_issue: [],
  github_label: [],
  github_open_pr: [],
  sheets_read: [],
  sheets_append: [],
  sheets_update: [],
  youtube_stats: [],
  instagram_insights: [],
  instagram_publish: [],
  // Drafts only (the insert policy refuses anything else); never status
  skill_propose: ["skills+"],
  skill_list: [],
  skill_run: ["skills.runs", "skills.successes", "skills.failures", "skills.last_run_at"],
  // Born draft or needs_review (insert policy); draft invoices have no number
  ledger_list: [],
  ledger_draft_entry: ["ledger_entries+"],
  invoice_draft: ["invoices+"],
  // Born upcoming; `verified` is computed by code. No tool writes facts.
  facts_lookup: [],
  obligation_add: ["obligations+"],
  obligation_list: [],
  kit_prepare: ["kits+"],
  // Computed by code from the page (lib/browser/kits.ts)
  kit_check: ["kits.status:verified|unverified", "kits.checked_at"],
}

// Changes only the person makes, through their own server actions. Agent
// tools share the person's database identity, so this is enforced by which
// tools exist, not by RLS (DATA_MODEL §4, AT-POL-07).
export const PERSON_ONLY_WRITES = [
  "memories.trust",
  "memories.pinned",
  "agents.memory_paused",
  "approvals",
  "episodes",
  "share_links",
  "schedules.status:active",
  "goals.status:active",
  "goals.status:abandoned",
  "ledger_entries.status:confirmed",
  "skills.status:approved",
  // Undo (K3) is the person's action, never a tool
  "tool_executions.undone_at",
  // A13: only the person closes a deadline; only the fact job writes facts
  "obligations.status:done",
  "obligations.status:dismissed",
  "public_facts",
  // A6: only the person signs in, saves a login and allows background use
  "login_profiles+",
  "login_profiles.status:active",
  "login_profiles.background_allowed",
  "login_profiles.label",
]
