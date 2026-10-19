"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import * as ledger from "@/lib/ledger"
import { allow } from "@/lib/rate-limit"

// The person's side of Accounts (A7): confirming, editing and voiding
// entries; drafting, issuing (R2: the number is permanent), paying and
// voiding invoices; the export for their CA. Confirming, paying and voiding
// are never agent tools (DATA_MODEL §3.5, TOOLS §2.5). Behind
// agents.ledger; the plan's ledger_enabled is checked in SQL.

const OFF = { error: "Accounts aren't available yet." }
const id = z.uuid()
const ids = z.array(z.uuid()).min(1).max(200)
const state = z
  .string()
  .regex(/^[0-9]{2}$/)
  .nullish()
const period = z.object({ from: z.iso.date(), to: z.iso.date() })

async function person() {
  const user = await requireUser()
  return (await getSetting("agents.ledger")) === "on" ? user : null
}

const done = <T>(result: T) => {
  revalidatePath("/accounts")
  return result
}

// The SQL plan check's message, in the person's words
const planError = (error: unknown) => {
  if (
    /ledger isn't on this plan/.test(`${error} ${(error as { cause?: unknown })?.cause}`)
  ) {
    return { error: "Accounts aren't part of your plan." }
  }
  throw error
}

export async function addEntry(bill: ledger.Bill, stateCode?: string | null) {
  const user = await person()
  const parsed = ledger.billSchema.safeParse(bill)
  const myState = state.safeParse(stateCode)
  if (!user || !parsed.success || !myState.success) return OFF
  try {
    return done(
      await ledger.addEntries(user.id, [parsed.data], {
        createdBy: "user",
        stateCode: myState.data,
      })
    )
  } catch (error) {
    return planError(error)
  }
}

export async function confirmEntries(entryIds: string[], note?: string) {
  const user = await person()
  const parsed = ids.safeParse(entryIds)
  const reviewNote = z.string().trim().max(500).optional().safeParse(note)
  if (!user || !parsed.success || !reviewNote.success) return OFF
  const confirmed = await ledger.confirmEntries(user.id, parsed.data, reviewNote.data)
  return done({ confirmed: confirmed.length })
}

export async function editEntry(
  entryId: string,
  bill: ledger.Bill,
  stateCode?: string | null
) {
  const user = await person()
  const parsed = id.safeParse(entryId)
  const data = ledger.billSchema.safeParse(bill)
  const myState = state.safeParse(stateCode)
  if (!user || !parsed.success || !data.success || !myState.success) return OFF
  const row = await ledger.editEntry(user.id, parsed.data, data.data, myState.data)
  return done(row ?? { error: "Only entries that aren't confirmed can be edited." })
}

export async function voidEntry(entryId: string) {
  const user = await person()
  const parsed = id.safeParse(entryId)
  if (!user || !parsed.success) return OFF
  return done(
    (await ledger.voidEntry(user.id, parsed.data))
      ? { ok: true as const }
      : { error: "That entry can't be voided." }
  )
}

export async function createInvoiceDraft(input: ledger.InvoiceInput) {
  const user = await person()
  const parsed = ledger.invoiceInputSchema.safeParse(input)
  if (!user || !parsed.success) return OFF
  try {
    return done({ invoice: await ledger.createInvoiceDraft(user.id, parsed.data) })
  } catch (error) {
    return planError(error)
  }
}

// The confirmation dialog names the number before this runs (UX_SPEC §9)
export async function issueInvoice(invoiceId: string) {
  const user = await person()
  const parsed = id.safeParse(invoiceId)
  if (!user || !parsed.success) return OFF
  if (!(await allow(`invoice:${user.id}`, 60, 3600))) {
    return { error: "Too many invoices this hour. Try again later." }
  }
  return done(await ledger.issueInvoice(user.id, parsed.data))
}

export async function setInvoiceStatus(invoiceId: string, status: "paid" | "void") {
  const user = await person()
  const parsed = id.safeParse(invoiceId)
  const next = z.enum(["paid", "void"]).safeParse(status)
  if (!user || !parsed.success || !next.success) return OFF
  const row = await ledger.setInvoiceStatus(user.id, parsed.data, next.data)
  return done(
    row ? { ok: true as const } : { error: "Only an issued invoice can change." }
  )
}

export async function exportPeriod(from: string, to: string) {
  const user = await person()
  const parsed = period.safeParse({ from, to })
  if (!user || !parsed.success || parsed.data.from > parsed.data.to) return OFF
  if (!(await allow(`ledger-export:${user.id}`, 10, 3600))) {
    return { error: "Too many exports this hour. Try again later." }
  }
  revalidatePath("/account")
  return ledger.exportPeriod(user.id, parsed.data)
}
