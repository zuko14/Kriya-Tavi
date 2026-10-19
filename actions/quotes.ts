"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { explain, setGoalBudget } from "@/lib/goals"
import { parseRate } from "@/lib/money"
import { quoteFor, type Quote } from "@/lib/quotes"
import { setScheduleCap } from "@/lib/schedules"

// ₹ quotes and caps (K2, agents.quotes). A quote is built only from real
// charges (lib/quotes.ts). A cap is whole rupees set by the person; it
// becomes the run's budget with the owner's exchange rate, so without one
// it can't be enforced and the person is told so.

const key = z.union([
  z.object({ workflowId: z.string().min(1).max(40) }),
  z.object({ skillId: z.string().min(1).max(40) }),
  z.object({ scheduleId: z.string().min(1).max(32) }),
])

export async function getQuote(
  input: z.input<typeof key>
): Promise<{ quote: Quote | null; capsAvailable: boolean } | null> {
  const user = await requireUser()
  if ((await getSetting("agents.quotes")) !== "on") return null
  const parsed = key.safeParse(input)
  if (!parsed.success) return null
  return {
    quote: await quoteFor(user.id, parsed.data),
    capsAvailable: parseRate(await getSetting("fx.usdInr")) !== null,
  }
}

const cap = z.object({
  target: z.enum(["schedule", "goal"]),
  id: z.string().min(1).max(32),
  // Whole rupees; null removes the cap
  rupees: z.number().int().min(1).max(1_00_000).nullable(),
})

export async function setCap(
  target: "schedule" | "goal",
  id: string,
  rupees: number | null
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser()
  if ((await getSetting("agents.quotes")) !== "on") {
    return { error: "₹ limits aren't available yet." }
  }
  const parsed = cap.safeParse({ target, id, rupees })
  if (!parsed.success) return { error: "Enter whole rupees between ₹1 and ₹1,00,000." }
  const micro = parsed.data.rupees === null ? null : parsed.data.rupees * 1_000_000
  try {
    await withUser(user.id, (tx) =>
      parsed.data.target === "goal"
        ? setGoalBudget(tx, parsed.data.id, micro)
        : setScheduleCap(tx, parsed.data.id, micro)
    )
  } catch (error) {
    return { error: explain(error, "Couldn't save the limit. Try again.") }
  }
  revalidatePath("/goals", "layout")
  return { ok: true }
}
