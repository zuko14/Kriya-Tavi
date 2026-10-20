"use server"

import { inArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { OwnerState } from "@/actions/owner"
import { privileged } from "@/db"
import { voiceCharges, voicePrices } from "@/db/schema"
import { requireOwner } from "@/lib/auth"
import { audit } from "@/lib/owner"
import { repriceVoiceTask } from "@/lib/voice/metering"

// The owner's voice price sheet (COST_AND_METERING §2): entered from written
// quotes, each with its source. Saving reprices estimated and unpriced
// voice charges; final ones never change.

// "0.45" → 450000 micro-units, in strings so no float touches the price
const amount = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, "Use a plain amount, e.g. 0.45")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".")
    return Number(BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")))
  })

const priceSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.-]+:[a-z0-9_.:/-]+$/, "Use provider:product, e.g. exotel:outbound"),
  provider: z.string().trim().min(1).max(40),
  product: z.string().trim().min(1).max(120),
  unit: z.enum([
    "second",
    "minute_pulse_60",
    "minute_pulse_30",
    "attempt",
    "character",
    "audio_second",
  ]),
  priceMicro: amount,
  currency: z.enum(["INR", "USD"]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
  source: z.string().trim().min(1, "Say where the price came from.").max(300),
})

const text = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}

export async function saveVoicePrice(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  const parsed = priceSchema.safeParse({
    id: text(form, "id"),
    provider: text(form, "provider"),
    product: text(form, "product"),
    unit: text(form, "unit"),
    priceMicro: text(form, "price"),
    currency: text(form, "currency"),
    effectiveFrom: text(form, "effectiveFrom"),
    source: text(form, "source"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const { effectiveFrom, ...price } = parsed.data
  const row = {
    ...price,
    // Midnight IST of the day the quote takes effect
    effectiveFrom: new Date(`${effectiveFrom}T00:00:00+05:30`),
    checkedAt: new Date(),
  }
  await privileged
    .insert(voicePrices)
    .values(row)
    .onConflictDoUpdate({ target: voicePrices.id, set: row })
  await audit(
    owner.id,
    "voice.price.save",
    { type: "voice_price", id: row.id },
    {
      priceMicro: row.priceMicro,
      currency: row.currency,
      unit: row.unit,
      source: row.source,
    }
  )
  const open = await privileged
    .select({ taskId: voiceCharges.voiceTaskId })
    .from(voiceCharges)
    .where(inArray(voiceCharges.status, ["estimated", "unpriced"]))
  for (const { taskId } of open) if (taskId) await repriceVoiceTask(taskId)
  revalidatePath("/owner/config")
  revalidatePath("/owner/finance")
  return {
    message: `${row.id} saved.${open.length ? ` ${open.length} voice charges repriced.` : ""}`,
  }
}
