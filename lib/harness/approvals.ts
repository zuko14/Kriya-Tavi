import { and, eq, sql } from "drizzle-orm"
import type { z } from "zod"

import { privileged } from "@/db"
import { harnessApprovalRequests as requests } from "@/db/schema"
import { redactInput } from "@/lib/agent/approvals"
import type { DeviceUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import type { ApprovalCreateRequest, ApprovalStatus } from "@/lib/harness/contract"

// Approvals from the phone (H5, HD-08): a device asks, the person answers in
// the Inbox (actions/harness.ts, a session through withUser), the device
// long-polls. The device side has no session, and the table has no insert
// policy, so these writes are privileged after authenticateDevice, always
// scoped by the device's person and the device itself: one device can't
// read or cancel another's requests. Nothing here answers a request (HS-4).

type Status = z.infer<typeof ApprovalStatus>

const POLL_MS = 1_000
// ARCHITECTURE §5: at most 2 long-polls per device.
// shortcut: counted per server process, upgrade to a shared counter if kriya-web runs more than one instance
const MAX_WAITING = 2
const waiting = new Map<string, number>()

// redactInput matches only keys that start with a secret word, and it
// truncates over 4 000 characters before redacting (HF-12), so device inputs
// (up to 8 KB) are walked first: any value under a key naming a secret goes
const SECRET_KEY =
  /pass(word|wd|phrase)|secret|token|api[-_]?key|^auth$|authorization|cookie|credential|private[-_]?key|^otp$|cvv|card[-_]?number/i

function hideSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideSecrets)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      inner && typeof inner === "object"
        ? hideSecrets(inner)
        : SECRET_KEY.test(key)
          ? "[redacted]"
          : inner,
    ])
  )
}

export async function createApproval(
  device: DeviceUser,
  body: z.infer<typeof ApprovalCreateRequest>
) {
  const minutes =
    Number.parseInt((await getSetting("harness.approvalTtlMinutes")) ?? "", 10) || 30
  const [row] = await privileged
    .insert(requests)
    .values({
      userId: device.id,
      deviceId: device.deviceId,
      sessionRef: body.sessionRef,
      tool: body.tool,
      summary: body.summary,
      input: redactInput(hideSecrets(body.input)),
      cwd: body.cwd ?? null,
      expiresAt: sql`now() + make_interval(mins => ${minutes})`,
    })
    .returning({ id: requests.id, expiresAt: requests.expiresAt })
  return { id: row.id, expiresAt: row.expiresAt.toISOString() }
}

const mine = (device: DeviceUser, id: string) =>
  and(
    eq(requests.id, id),
    eq(requests.userId, device.id),
    eq(requests.deviceId, device.deviceId)
  )

// The request's status; a pending one past its expiry is written expired
// (DSH fails closed). Null when it isn't this device's
async function readStatus(device: DeviceUser, id: string): Promise<Status | null> {
  const [row] = await privileged
    .select({
      status: requests.status,
      over: sql<boolean>`${requests.expiresAt} <= now()`,
    })
    .from(requests)
    .where(mine(device, id))
  if (!row) return null
  if (row.status !== "pending" || !row.over) return row.status
  const [expired] = await privileged
    .update(requests)
    .set({ status: "expired" })
    .where(and(mine(device, id), eq(requests.status, "pending")))
    .returning({ status: requests.status })
  // Answered in the meantime: that answer stands
  return expired ? "expired" : readStatus(device, id)
}

// Waits up to `seconds` for an answer; "busy" when the device already has
// MAX_WAITING long-polls open
export async function waitForAnswer(
  device: DeviceUser,
  id: string,
  seconds: number,
  signal: AbortSignal
): Promise<Status | null | "busy"> {
  if (seconds === 0) return readStatus(device, id)
  const open = waiting.get(device.deviceId) ?? 0
  if (open >= MAX_WAITING) return "busy"
  waiting.set(device.deviceId, open + 1)
  try {
    const deadline = Date.now() + seconds * 1_000
    for (;;) {
      const status = await readStatus(device, id)
      const left = deadline - Date.now()
      if (status !== "pending" || left <= 0 || signal.aborted) return status
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)))
    }
  } finally {
    const left = (waiting.get(device.deviceId) ?? 1) - 1
    if (left) waiting.set(device.deviceId, left)
    else waiting.delete(device.deviceId)
  }
}

// The person answered in the terminal: a pending request becomes canceled,
// an answered one stays as it is. False when it isn't this device's
export async function cancelApproval(device: DeviceUser, id: string) {
  const [canceled] = await privileged
    .update(requests)
    .set({ status: "canceled" })
    .where(and(mine(device, id), eq(requests.status, "pending")))
    .returning({ id: requests.id })
  if (canceled) return true
  const [found] = await privileged
    .select({ id: requests.id })
    .from(requests)
    .where(mine(device, id))
  return Boolean(found)
}
