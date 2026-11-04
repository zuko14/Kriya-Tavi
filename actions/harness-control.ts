"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { cancel, ControlError, queue } from "@/lib/harness/control"
import { DispatchKind } from "@/lib/harness/contract"
import { allow } from "@/lib/rate-limit"

// The person's side of the Control Center (CONTROL_CENTER.md): queue an
// action for one of their own computers, or stop one. Identity is the
// session's; every check is in lib/harness/control.ts and again in RLS. A
// computer runs only what its own daemon allows.

const OFF = { error: "The Control Center isn't available." }

async function ready(userId: string) {
  if ((await getSetting("harness.api")) !== "on") return OFF
  if ((await getSetting("harness.controlCenter")) !== "on") return OFF
  if (!(await allow(`harness:control:${userId}`, 20, 60)))
    return { error: "Too many actions. Wait a minute and try again." }
  return null
}

const Input = z.object({ deviceId: z.uuid(), kind: DispatchKind, payload: z.unknown() })

export async function dispatchAction(input: {
  deviceId: string
  kind: string
  payload: unknown
}) {
  const user = await requireUser()
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { error: "That action isn't complete." }
  const blocked = await ready(user.id)
  if (blocked) return blocked
  try {
    const id = await queue(
      user.id,
      parsed.data.deviceId,
      parsed.data.kind,
      parsed.data.payload ?? {}
    )
    revalidatePath("/harness")
    return { ok: true as const, id }
  } catch (error) {
    if (error instanceof ControlError) return { error: error.message }
    throw error
  }
}

export async function cancelAction(input: { id: string }) {
  const user = await requireUser()
  const parsed = z.object({ id: z.uuid() }).safeParse(input)
  if (!parsed.success) return { error: "Which action?" }
  const blocked = await ready(user.id)
  if (blocked) return blocked
  try {
    await cancel(user.id, parsed.data.id)
    revalidatePath("/harness")
    return { ok: true as const }
  } catch (error) {
    if (error instanceof ControlError) return { error: error.message }
    throw error
  }
}
