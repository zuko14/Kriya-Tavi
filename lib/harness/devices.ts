import { createHash, randomBytes } from "node:crypto"

import { and, count, eq, gt, isNull, ne, sql, sum } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import {
  agents,
  harnessDeviceCodes,
  harnessDevices,
  harnessUsage,
  profiles,
} from "@/db/schema"
import type { DeviceUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"
import { USER_CODE_ALPHABET, type DeviceCodeRequest } from "@/lib/harness/contract"
import type { z } from "zod"

// The device sign-in flow and the device's own account view (HD-05,
// API_AND_CONTRACTS §2). Codes and tokens are 32 random bytes, stored only as
// sha256. The codes table is server-only, so its writes are privileged; the
// person's approval is checked by the session (requireUser) in
// actions/harness.ts, and their agent through withUser.

export const CODE_SECONDS = 600
export const POLL_SECONDS = 5

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const secret = () => randomBytes(32).toString("base64url")

// "abcd-2345" or "ABCD2345" → "ABCD2345", or null
export function normalizeUserCode(input: string) {
  const code = input.toUpperCase().replace(/[\s-]/g, "")
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null
}

export async function createDeviceCode(input: z.infer<typeof DeviceCodeRequest>) {
  const deviceCode = secret()
  for (let attempt = 0; ; attempt++) {
    // 256 is a multiple of the 32-letter alphabet: every letter equally likely
    const userCode = Array.from(randomBytes(8), (b) => USER_CODE_ALPHABET[b % 32]).join(
      ""
    )
    try {
      await privileged.insert(harnessDeviceCodes).values({
        deviceCodeHash: sha(deviceCode),
        userCode,
        deviceName: input.deviceName,
        platform: input.platform,
        clientVersion: input.clientVersion,
        expiresAt: new Date(Date.now() + CODE_SECONDS * 1000),
      })
      return {
        deviceCode,
        userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
        expiresIn: CODE_SECONDS as 600,
        interval: POLL_SECONDS as 5,
      }
    } catch (error) {
      // A user code already in use: draw again
      if (attempt >= 4) throw error
    }
  }
}

type Issued =
  | { status: "issued"; token: string; deviceId: string }
  | { status: "pending" | "denied" | "expired" | "slow_down" }

// The client's poll: the token once, after the person approved
export async function issueToken(deviceCode: string): Promise<Issued> {
  return privileged.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(harnessDeviceCodes)
      .where(eq(harnessDeviceCodes.deviceCodeHash, sha(deviceCode)))
      .for("update")
    const now = Date.now()
    if (!row || row.consumedAt || row.expiresAt.getTime() <= now)
      return { status: "expired" }
    const fast =
      row.lastPolledAt !== null && now - row.lastPolledAt.getTime() < POLL_SECONDS * 1000
    await tx
      .update(harnessDeviceCodes)
      .set({ lastPolledAt: new Date(now) })
      .where(eq(harnessDeviceCodes.deviceCodeHash, row.deviceCodeHash))
    if (fast) return { status: "slow_down" }
    if (row.deniedAt) return { status: "denied" }
    if (!row.approvedAt || !row.approvedBy) return { status: "pending" }
    const token = secret()
    const [device] = await tx
      .insert(harnessDevices)
      .values({
        userId: row.approvedBy,
        agentId: row.agentId,
        name: row.deviceName,
        platform: row.platform,
        clientVersion: row.clientVersion,
        tokenHash: sha(token),
      })
      .returning({ id: harnessDevices.id })
    await tx
      .update(harnessDeviceCodes)
      .set({ consumedAt: new Date(now), deviceId: device.id })
      .where(eq(harnessDeviceCodes.deviceCodeHash, row.deviceCodeHash))
    return { status: "issued", token, deviceId: device.id }
  })
}

// A code the person can still answer: not expired, answered or used
const open = (code: string) =>
  and(
    eq(harnessDeviceCodes.userCode, code),
    isNull(harnessDeviceCodes.approvedAt),
    isNull(harnessDeviceCodes.deniedAt),
    isNull(harnessDeviceCodes.consumedAt),
    gt(harnessDeviceCodes.expiresAt, new Date())
  )

const GONE = "That code has expired or was already used. Run kriya login again."

export async function answerCode(
  userId: string,
  input: string,
  answer: { approve: true; agentId: string | null } | { approve: false }
) {
  const code = normalizeUserCode(input)
  if (!code) return { error: "That isn't a sign-in code." }
  if (answer.approve && answer.agentId) {
    const agentId = answer.agentId
    // Only the person's own agent: looked up as them (RLS)
    const mine = await withUser(userId, (tx) =>
      tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))
    )
    if (!mine.length) return { error: "Choose one of your agents." }
  }
  const answered = await privileged
    .update(harnessDeviceCodes)
    .set(
      answer.approve
        ? { approvedBy: userId, agentId: answer.agentId, approvedAt: new Date() }
        : { deniedAt: new Date() }
    )
    .where(open(code))
    .returning({ code: harnessDeviceCodes.userCode })
  return answered.length ? { ok: true as const } : { error: GONE }
}

// What the connect page shows about a code (nothing about anyone's account)
export async function codeView(input: string) {
  const code = normalizeUserCode(input)
  if (!code) return null
  const [row] = await privileged
    .select({
      deviceName: harnessDeviceCodes.deviceName,
      platform: harnessDeviceCodes.platform,
      createdAt: harnessDeviceCodes.createdAt,
      expiresAt: harnessDeviceCodes.expiresAt,
      approvedAt: harnessDeviceCodes.approvedAt,
      deniedAt: harnessDeviceCodes.deniedAt,
      consumedAt: harnessDeviceCodes.consumedAt,
    })
    .from(harnessDeviceCodes)
    .where(eq(harnessDeviceCodes.userCode, code))
  if (!row) return null
  const state =
    row.consumedAt || row.approvedAt
      ? "used"
      : row.deniedAt
        ? "denied"
        : row.expiresAt.getTime() <= Date.now()
          ? "expired"
          : "open"
  return {
    code: `${code.slice(0, 4)}-${code.slice(4)}`,
    deviceName: row.deviceName,
    platform: row.platform,
    createdAt: row.createdAt,
    state: state as "open" | "used" | "denied" | "expired",
  }
}

// DELETE /device: the calling device signs itself out
export async function revokeSelf(device: DeviceUser) {
  await privileged
    .update(harnessDevices)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(harnessDevices.id, device.deviceId), eq(harnessDevices.userId, device.id))
    )
}

const MONTH = sql`(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`

// This IST month's harness spend: charges, or reservations while unpriced
export async function harnessSpend(userId: string) {
  const [row] = await privileged
    .select({
      used: sum(
        sql`coalesce(${harnessUsage.chargeMicroInr}, ${harnessUsage.reservedMicroInr})`
      ).mapWith(Number),
      unpriced: count(
        sql`case when ${harnessUsage.chargeStatus} = 'unpriced' then 1 end`
      ),
    })
    .from(harnessUsage)
    .where(
      and(
        eq(harnessUsage.userId, userId),
        ne(harnessUsage.status, "failed"),
        sql`${harnessUsage.createdAt} >= ${MONTH}`
      )
    )
  return { used: row?.used ?? 0, unpriced: row?.unpriced ?? 0 }
}

// GET /me
export async function deviceAccount(device: DeviceUser) {
  const [profile] = await privileged
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, device.id))
  const plan = await getPlan(device.id)
  const spend = await harnessSpend(device.id)
  const [agent] = device.agentId
    ? await privileged
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, device.agentId), eq(agents.userId, device.id)))
    : []
  const cap = Number(plan.harnessMonthlyMicroInr)
  return {
    displayName: profile?.displayName ?? null,
    plan: plan.name,
    harness: {
      enabled: cap > 0 && (await getSetting("harness.gateway")) === "on",
      capMicroInr: cap,
      usedMicroInr: spend.used,
      unpriced: spend.unpriced,
    },
    agent: agent ?? null,
    minClientVersion: (await getSetting("harness.minClientVersion")) ?? "0.0.0",
  }
}
