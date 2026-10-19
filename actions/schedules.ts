"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { requireUser } from "@/lib/auth"
import { explain } from "@/lib/goals"
import { setScheduleStatus } from "@/lib/schedules"

// Pause, resume or end a schedule (A3). Creating one goes through an agent's
// schedule_create, which the person approves first (R2). Resuming is the
// person's alone: no agent tool and no scheduler path sets "active".

const input = z.object({
  scheduleId: z.string().min(1).max(32),
  status: z.enum(["active", "paused", "ended"]),
})

export async function changeSchedule(
  scheduleId: string,
  status: "active" | "paused" | "ended"
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser()
  const parsed = input.safeParse({ scheduleId, status })
  if (!parsed.success) return { error: "That request wasn't valid." }
  try {
    await withUser(user.id, (tx) =>
      setScheduleStatus(tx, parsed.data.scheduleId, parsed.data.status)
    )
  } catch (error) {
    return { error: explain(error, "Couldn't change the schedule. Try again.") }
  }
  revalidatePath("/goals", "layout")
  return { ok: true }
}
