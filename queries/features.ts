import "server-only"

import { getSetting, type SettingKey } from "@/lib/config"
import { roomsEnabled } from "@/lib/rooms/core"
import { studioOn } from "@/lib/skill-studio"
import { voiceAvailable } from "@/lib/voice/tasks"

// Which places exist for this person, so navigation shows every switched-on
// feature and nothing else. Each flag uses the same check as its page's own
// notFound(), so a link never leads to a 404.
export type Features = {
  inbox: boolean
  goals: boolean
  rooms: boolean
  calls: boolean
  ledger: boolean
  radar: boolean
  studio: boolean
  apps: boolean
  harness: boolean
  jobs: boolean
}

export async function getFeatures(userId: string): Promise<Features> {
  const on = async (key: SettingKey) => (await getSetting(key)) === "on"
  const [
    inbox,
    goals,
    rooms,
    calls,
    ledger,
    radar,
    watchers,
    studio,
    mcp,
    mcpConnect,
    harness,
    jobs,
  ] = await Promise.all([
    on("agents.inbox"),
    on("agents.goals"),
    roomsEnabled(),
    voiceAvailable(userId),
    on("agents.ledger"),
    on("agents.radar"),
    on("agents.watchers"),
    studioOn(),
    on("next.mcp"),
    on("next.mcpConnect"),
    on("harness.api"),
    on("operator.mandates"),
  ])
  return {
    inbox,
    goals,
    rooms,
    calls,
    ledger,
    radar: radar || watchers,
    studio,
    apps: mcp && mcpConnect,
    harness,
    jobs,
  }
}
