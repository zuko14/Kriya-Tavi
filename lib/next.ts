// Track N switch dependencies (ND-23). A switch whose dependency is off does
// nothing; the owner's Config page says so beside it, and the code that
// reads the switch reads its dependencies too. Pure.

// A dependency is a switch that must be "on", or `next.embeddingModel`,
// which must be set
export const NEXT_NEEDS: Record<string, string[]> = {
  "next.delivery": ["agents.inbox"],
  "next.recheck": ["agents.inbox", "next.delivery"],
  "next.mcp": ["agents.inbox"],
  "next.mcpConnect": ["next.mcp"],
  "next.skillsV2": ["agents.skillLibrary"],
  "next.memoryRerank": ["agents.memoryV2", "next.embeddingModel"],
}

// Model ids on which a cache marker was shown, by one paid request the owner
// approved (NRG-2), to pass through OpenRouter and come back as cached tokens;
// the evidence goes in status.md. Empty: no route is proven, so `next.promptCache`
// changes nothing. An id added here must be exactly what was tested.
export const CACHE_VERIFIED: readonly string[] = []

const met = (key: string, value: string | null) =>
  key === "next.embeddingModel" ? !!value : value === "on"

// The note for a switch that's on but can't take effect, or null
export function ineffectiveNote(
  key: string,
  valueOf: (key: string) => string | null,
  tokenKeySet = true
) {
  if (key === "next.promptCache" && valueOf(key) === "on" && CACHE_VERIFIED.length === 0)
    return "On, but has no effect yet: no model route has been verified to keep cache markers (NRG-2)."
  const needs = NEXT_NEEDS[key]
  if (!needs || valueOf(key) !== "on") return null
  const missing = needs.filter((need) => !met(need, valueOf(need)))
  if (key === "next.mcp" && !tokenKeySet) missing.push("KRIYA_TOKEN_KEY")
  const verb = (need: string) =>
    need === "next.embeddingModel" || need === "KRIYA_TOKEN_KEY" ? "set" : "on"
  return missing.length
    ? `On, but has no effect yet: ${missing.map((need) => `${need} must be ${verb(need)}`).join(" and ")}.`
    : null
}
