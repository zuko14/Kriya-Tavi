import { and, desc, eq, ilike, or, sql } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import { publicFacts, resourceUsage } from "@/db/schema"
import { webFetch } from "@/lib/web"

// The public facts commons (K6, AD-32): official facts many people ask
// about, stored once with the exact quote and URL. Written only by the fact
// job below, from targets the owner lists here, on allow-listed official
// domains (checked again by a database trigger); never from a person's
// task, a person's watcher or any URL a person gave. Served only after two
// agreeing fetches at least an hour apart.

export type FactTarget = {
  // e.g. exam.gate.2027.registration_close
  key: string
  url: string
  // Must match the official page's own words; the named group `value` is
  // the fact, the whole match is the quote
  pattern: RegExp
  refreshHours?: number
  ttlDays?: number
}

// Owner-defined (owner, 2026-10-18). Empty until targets are reviewed:
// add one only with its page read by a person first.
export const FACT_TARGETS: FactTarget[] = []

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

export function factFromText(target: FactTarget, text: string) {
  const match = target.pattern.exec(text)
  const value = match?.groups?.value?.trim()
  if (!match || !value) return null
  const quote = match[0].replace(/\s+/g, " ").trim()
  if (quote.length > 500 || !quote.includes(value)) return null
  return { value, quote }
}

export type FactOutcome =
  "not_found" | "added" | "confirmed" | "too_soon" | "changed" | "retracted" | "rejected"

// One fetch of one target. A matching fetch an hour or more after the last
// counted one adds a confirmation; a different value starts again at one.
export async function recordFactFetch(
  target: FactTarget,
  text: string,
  now = new Date()
): Promise<FactOutcome> {
  const found = factFromText(target, text)
  if (!found) return "not_found"
  const url = new URL(target.url)
  const values = {
    value: found.value,
    quote: found.quote,
    sourceUrl: url.href,
    sourceDomain: url.hostname.toLowerCase(),
    expiresAt: new Date(now.getTime() + (target.ttlDays ?? 30) * DAY),
    updatedAt: now,
  }
  const [existing] = await privileged
    .select()
    .from(publicFacts)
    .where(eq(publicFacts.key, target.key))
  try {
    if (!existing) {
      await privileged
        .insert(publicFacts)
        .values({ key: target.key, ...values, fetchedAt: now, confirmations: 1 })
      return "added"
    }
    // A retracted fact stays retracted until the owner acts
    if (existing.retractedAt) return "retracted"
    if (existing.value !== found.value || existing.quote !== found.quote) {
      await privileged
        .update(publicFacts)
        .set({ ...values, fetchedAt: now, confirmations: 1 })
        .where(eq(publicFacts.key, target.key))
      return "changed"
    }
    if (now.getTime() - existing.fetchedAt.getTime() < HOUR) return "too_soon"
    await privileged
      .update(publicFacts)
      .set({ ...values, fetchedAt: now, confirmations: existing.confirmations + 1 })
      .where(eq(publicFacts.key, target.key))
    return "confirmed"
  } catch (error) {
    // The allow-list trigger refused the domain
    if (
      /not an allowed official domain|don't match/.test(
        `${error} ${(error as { cause?: unknown })?.cause}`
      )
    ) {
      return "rejected"
    }
    throw error
  }
}

export type Fetch = (url: string) => Promise<string>
const defaultFetch: Fetch = async (url) => (await webFetch(url, 20_000)).markdown

// The worker's fact job: each target whose last fetch is older than its
// refresh time. Fetches are metered (unpriced until RG-11).
export async function runFactJob(
  options: { targets?: FactTarget[]; fetch?: Fetch; now?: Date } = {}
) {
  const now = options.now ?? new Date()
  const results: { key: string; outcome: FactOutcome | "failed" }[] = []
  for (const target of options.targets ?? FACT_TARGETS) {
    const [existing] = await privileged
      .select({ fetchedAt: publicFacts.fetchedAt, updatedAt: publicFacts.updatedAt })
      .from(publicFacts)
      .where(eq(publicFacts.key, target.key))
    const last = existing?.updatedAt ?? existing?.fetchedAt
    if (last && now.getTime() - last.getTime() < (target.refreshHours ?? 6) * HOUR)
      continue
    try {
      const text = await (options.fetch ?? defaultFetch)(target.url)
      await privileged
        .insert(resourceUsage)
        .values({
          requestKey: `fact:${target.key}:${now.toISOString()}`,
          userId: null,
          kind: "web_fetch",
          quantity: 1,
          costMicroUsd: null,
        })
        .onConflictDoNothing()
      results.push({ key: target.key, outcome: await recordFactFetch(target, text, now) })
    } catch {
      results.push({ key: target.key, outcome: "failed" })
    }
  }
  return results
}

// Agents and people read served facts only (RLS: confirmed twice, current,
// not retracted), as the person
export async function lookupFacts(
  userId: string,
  input: { key?: string; query?: string }
) {
  const words = (input.query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .slice(0, 5)
  if (!input.key && words.length === 0) return []
  const rows = await withUser(userId, (tx) =>
    tx
      .select()
      .from(publicFacts)
      .where(
        input.key
          ? eq(publicFacts.key, input.key)
          : and(
              ...words.map((w) =>
                or(ilike(publicFacts.key, `%${w}%`), ilike(publicFacts.value, `%${w}%`))
              )
            )
      )
      .orderBy(desc(publicFacts.fetchedAt))
      .limit(5)
  )
  const date = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
  return rows.map((f) => ({
    key: f.key,
    value: f.value,
    quote: f.quote,
    source_url: f.sourceUrl,
    fetched_at: f.fetchedAt.toISOString(),
    note: `Read from ${f.sourceDomain} on ${date.format(f.fetchedAt)}.`,
  }))
}

// The owner console (audited by the caller)
export async function listAllFacts() {
  return privileged
    .select({
      key: publicFacts.key,
      value: publicFacts.value,
      quote: publicFacts.quote,
      sourceUrl: publicFacts.sourceUrl,
      sourceDomain: publicFacts.sourceDomain,
      fetchedAt: publicFacts.fetchedAt,
      confirmations: publicFacts.confirmations,
      retractedAt: publicFacts.retractedAt,
      expired: sql<boolean>`${publicFacts.expiresAt} <= now()`,
    })
    .from(publicFacts)
    .orderBy(desc(publicFacts.updatedAt))
    .limit(200)
}

export async function retractFact(ownerId: string, key: string) {
  const rows = await privileged
    .update(publicFacts)
    .set({ retractedAt: new Date(), retractedBy: ownerId })
    .where(eq(publicFacts.key, key))
    .returning({ key: publicFacts.key })
  return rows.length > 0
}
