import { HarnessProfile, profileDiff, profileId } from "./profile"
import type { Verdict } from "./gate"

// KRHE's Compose stage (RECURSIVE_HARNESS_EVOLUTION.md §4): join the
// one-factor changes that each held up (adopt or canary) into one profile.
// Changes to the same field conflict; the one with the larger paired margin
// wins and the other is recorded as dropped. A composed profile is a new,
// unmeasured candidate: it is probed and gated again, like any other
// (interactions between changes aren't assumed away). No change survives
// the gate → no composition, and the incumbent stays.

type Gated = { profile: HarnessProfile; verdict: Verdict; margin: number }

export function compose(incumbent: HarnessProfile, gated: Gated[]) {
  const kept = gated
    .filter((g) => g.verdict === "adopt" || g.verdict === "canary")
    .sort((a, b) => b.margin - a.margin)
  const merged: Record<string, unknown> = { ...incumbent }
  const taken = new Set<string>()
  const dropped: Array<{ id: string; why: string }> = []
  const used: string[] = []
  for (const g of kept) {
    const diff = profileDiff(incumbent, g.profile)
    const clash = diff.find((d) => taken.has(d.key))
    if (clash) {
      dropped.push({
        id: profileId(g.profile),
        why: `${clash.key} already set by a change with a larger margin`,
      })
      continue
    }
    for (const d of diff) {
      merged[d.key] = d.to
      taken.add(d.key)
    }
    used.push(profileId(g.profile))
  }
  if (used.length < 2)
    return {
      profile: undefined,
      used,
      dropped,
      note: used.length
        ? "one change held up: nothing to compose; its own verdict stands"
        : "no change held up: keep the incumbent",
    }
  const parsed = HarnessProfile.safeParse(merged)
  if (!parsed.success)
    return {
      profile: undefined,
      used,
      dropped,
      note: `the joined changes aren't a valid profile: ${parsed.error.issues[0]?.message}`,
    }
  return {
    profile: parsed.data,
    id: profileId(parsed.data),
    used,
    dropped,
    note: "composed: probe and gate it before any adoption",
  }
}
