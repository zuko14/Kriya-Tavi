import "server-only"

import { createHash, randomBytes } from "node:crypto"

import { getSetting } from "@/lib/config"

// Rooms (track R, R2): the switch and limits every room action and query
// reads, and invite tokens (RD-11). With rooms.enabled off nothing about
// rooms exists for anyone (RT-REG-01).

export async function roomsEnabled() {
  return (await getSetting("rooms.enabled")) === "on"
}

export async function roomLimit(
  key: "rooms.maxHumans" | "rooms.maxAgents" | "rooms.maxPerPerson" | "rooms.inviteDays"
) {
  return Number(await getSetting(key))
}

// An invite link's token: 32 random bytes. Only its sha256 is stored
export function newInviteToken() {
  const token = randomBytes(32).toString("base64url")
  return { token, hash: hashInviteToken(token) }
}

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}
