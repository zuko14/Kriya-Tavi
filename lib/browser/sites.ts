import { isIP } from "node:net"

// Per-site automation modes (AD-06). Changing a rule is a code change with a
// test, a RESEARCH.md §4 entry and the owner's approval; never a setting.
// A site becomes `supervised` only after its terms are read (AB-04), so none
// is yet. Sites not listed are read-only.

export type SiteRule = {
  domain: string // registrable domain
  mode: "api" | "supervised" | "assisted" | "blocked"
  reviewed: { date: string; source: string; clause: string } | null
  commitPatterns?: string[] // extra accessible-name words that mean commit
  securityPage?: string
  maxActionsPerDay?: number
}

// RESEARCH.md §4: no primary terms text has been read for any of these yet
export const SITES: readonly SiteRule[] = [
  { domain: "linkedin.com", mode: "assisted", reviewed: null },
  { domain: "upwork.com", mode: "assisted", reviewed: null },
  { domain: "naukri.com", mode: "assisted", reviewed: null },
  { domain: "internshala.com", mode: "assisted", reviewed: null },
  { domain: "google.com", mode: "api", reviewed: null },
  { domain: "notion.so", mode: "api", reviewed: null },
  { domain: "github.com", mode: "api", reviewed: null },
  { domain: "youtube.com", mode: "api", reviewed: null },
  { domain: "instagram.com", mode: "api", reviewed: null },
]

// ponytail: a short suffix list, not the full Public Suffix List; add a
// suffix when a reviewed site needs one
const SUFFIXES = new Set([
  "co.in",
  "net.in",
  "org.in",
  "gov.in",
  "ac.in",
  "edu.in",
  "nic.in",
  "res.in",
  "firm.in",
  "gen.in",
  "ind.in",
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
])

export function registrableDomain(host: string) {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (isIP(name)) return name
  const parts = name.split(".")
  const lastTwo = parts.slice(-2).join(".")
  return SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo
}

let rules: readonly SiteRule[] = SITES

// Tests give the fixture sites their modes here, never at runtime
export function setSitesForTests(next: readonly SiteRule[] | null) {
  rules = next ?? SITES
}

export function siteFor(urlOrHost: string): SiteRule | null {
  let host = urlOrHost
  try {
    host = new URL(urlOrHost).hostname
  } catch {}
  const domain = registrableDomain(host)
  return rules.find((rule) => rule.domain === domain) ?? null
}
