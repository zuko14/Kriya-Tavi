"use server"

import { and, eq, gt, isNull, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { harnessApprovalRequests, harnessDevices } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { answerCode } from "@/lib/harness/devices"
import { allow } from "@/lib/rate-limit"

// The person's side of Kriya Harness devices (HD-05): approving or denying a
// sign-in from a session (no device endpoint can), and renaming or revoking
// their devices through withUser (the column grants allow exactly these).
// H5 (HD-08): answering a device's approval request, from a session only.
// H6 (HD-09): the device's mirror mode.

const CODE = z.string().trim().min(8).max(12)
const OFF = { error: "Kriya Harness isn't available." }
const BUSY = { error: "Too many attempts. Wait a minute and try again." }

async function ready(userId: string) {
  if ((await getSetting("harness.api")) !== "on") return OFF
  if (!(await allow(`harness:connect:${userId}`, 10, 60))) return BUSY
  return null
}

export async function approveDevice(input: { code: string; agentId: string | null }) {
  const user = await requireUser()
  const parsed = z
    .object({ code: CODE, agentId: z.string().min(1).max(32).nullable() })
    .safeParse(input)
  if (!parsed.success) return { error: "That isn't a sign-in code." }
  const blocked = await ready(user.id)
  if (blocked) return blocked
  return answerCode(user.id, parsed.data.code, {
    approve: true,
    agentId: parsed.data.agentId,
  })
}

export async function denyDevice(input: { code: string }) {
  const user = await requireUser()
  const parsed = z.object({ code: CODE }).safeParse(input)
  if (!parsed.success) return { error: "That isn't a sign-in code." }
  const blocked = await ready(user.id)
  if (blocked) return blocked
  return answerCode(user.id, parsed.data.code, { approve: false })
}

const id = z.uuid()

export async function renameDevice(deviceId: string, name: string) {
  const user = await requireUser()
  const parsed = z.object({ id, name: z.string().trim().min(1).max(60) }).safeParse({
    id: deviceId,
    name,
  })
  if (!parsed.success) return { error: "Give the device a name of up to 60 characters." }
  const renamed = await withUser(user.id, (tx) =>
    tx
      .update(harnessDevices)
      .set({ name: parsed.data.name })
      .where(and(eq(harnessDevices.id, parsed.data.id), isNull(harnessDevices.revokedAt)))
      .returning({ id: harnessDevices.id })
  )
  revalidatePath("/account")
  return renamed.length ? { ok: true as const } : { error: "Device not found." }
}

export async function revokeDevice(deviceId: string) {
  const user = await requireUser()
  const parsed = id.safeParse(deviceId)
  if (!parsed.success) return { error: "Device not found." }
  const revoked = await withUser(user.id, (tx) =>
    tx
      .update(harnessDevices)
      .set({ revokedAt: new Date() })
      .where(and(eq(harnessDevices.id, parsed.data), isNull(harnessDevices.revokedAt)))
      .returning({ id: harnessDevices.id })
  )
  revalidatePath("/account")
  return revoked.length ? { ok: true as const } : { error: "Device not found." }
}

// The device's session mirror (H6, HD-09): off, summaries or everything.
// Only while the platform's mirror is on; the column grant allows it
export async function setDeviceMirror(
  deviceId: string,
  mirror: "off" | "summary" | "full"
) {
  const user = await requireUser()
  const parsed = z
    .object({ id, mirror: z.enum(["off", "summary", "full"]) })
    .safeParse({ id: deviceId, mirror })
  if (!parsed.success) return { error: "Device not found." }
  if ((await getSetting("harness.mirror")) !== "on")
    return { error: "The session mirror isn't available." }
  const changed = await withUser(user.id, (tx) =>
    tx
      .update(harnessDevices)
      .set({ mirror: parsed.data.mirror })
      .where(and(eq(harnessDevices.id, parsed.data.id), isNull(harnessDevices.revokedAt)))
      .returning({ id: harnessDevices.id })
  )
  revalidatePath("/account")
  return changed.length ? { ok: true as const } : { error: "Device not found." }
}

// Approve once or decline a device's pending request (H5). Only here, from
// the person's session (HS-4); RLS lets them answer only their own pending
// rows, and the first answer wins: an answered, canceled or expired request
// doesn't change
export async function answerHarnessApproval(
  approvalId: string,
  decision: "approved" | "declined"
) {
  const user = await requireUser()
  const parsed = z
    .object({ id, decision: z.enum(["approved", "declined"]) })
    .safeParse({ id: approvalId, decision })
  if (!parsed.success) return { error: "That request wasn't found." }
  if ((await getSetting("harness.api")) !== "on") return OFF
  const answered = await withUser(user.id, (tx) =>
    tx
      .update(harnessApprovalRequests)
      .set({ status: parsed.data.decision, answeredAt: new Date() })
      .where(
        and(
          eq(harnessApprovalRequests.id, parsed.data.id),
          eq(harnessApprovalRequests.status, "pending"),
          gt(harnessApprovalRequests.expiresAt, sql`now()`)
        )
      )
      .returning({ id: harnessApprovalRequests.id })
  )
  revalidatePath("/inbox")
  return answered.length
    ? { ok: true as const }
    : { error: "This request was already answered or has expired." }
}
