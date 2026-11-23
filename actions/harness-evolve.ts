"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { OwnerState } from "@/actions/owner"
import { requireOwner } from "@/lib/auth"
import {
  benchCandidate,
  decideCandidate,
  freezeScout,
  ProposalError,
} from "@/lib/harness/scout/proposal"
import { addScoutSource, setScoutSourceActive } from "@/lib/harness/scout/sources"
import {
  canaryVersion,
  promoteVersion,
  rollbackVersion,
  VersionError,
} from "@/lib/harness/scout/versions"
import { log } from "@/lib/log"
import { audit } from "@/lib/owner"

// Harness 2.0 W7: the owner's Scout sources (upgrade_2.0/SELF_EVOLUTION.md
// §2.2). Every action re-checks the role on the server and leaves an audit
// record with ids only. Nothing here is a tool: no agent can add a source.

const PAGE = "/owner/harness"
const field = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === "string" ? value.trim() : ""
}

export async function addScoutSourceAction(
  _: OwnerState,
  form: FormData
): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const row = await addScoutSource(
      {
        discipline: field(form, "discipline"),
        kind: field(form, "kind"),
        url: field(form, "url"),
      },
      owner.id
    )
    if (!row) return { error: "That address is already a source." }
    await audit(owner.id, "harness.scout.source.add", {
      type: "harness_scout_source",
      id: row.id,
    })
    revalidatePath(PAGE)
    return { message: "Source added. The Scout reads it on its next run." }
  } catch (error) {
    if (error instanceof z.ZodError)
      return { error: error.issues[0]?.message ?? "Invalid." }
    log.error("scout source add failed", { error: (error as Error)?.name ?? "error" })
    return { error: "That didn't save." }
  }
}

export async function setScoutSourceAction(
  _: OwnerState,
  form: FormData
): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const id = z.uuid().parse(field(form, "id"))
    const active = field(form, "active") === "on"
    await setScoutSourceActive(id, active)
    await audit(
      owner.id,
      active ? "harness.scout.source.resume" : "harness.scout.source.pause",
      { type: "harness_scout_source", id }
    )
    revalidatePath(PAGE)
    return { message: active ? "Resumed." : "Paused." }
  } catch (error) {
    if (error instanceof z.ZodError) return { error: "Unknown source." }
    log.error("scout source change failed", { error: (error as Error)?.name ?? "error" })
    return { error: "That didn't save." }
  }
}

/* ─────────────────────────── candidates (W9) ─────────────────────────── */

// SELF_EVOLUTION §3–4: the owner uploads both arms' bench reports, code
// computes the verdict; the owner approves or rejects. No form field carries
// a verdict or a status. Status changes write their own audit record in SQL
// (kriya.harness_candidate_transition), with the owner's id.

const reportTexts = async (form: FormData, name: string) => {
  const files = form
    .getAll(name)
    .filter((f): f is File => f instanceof File && f.size > 0)
  return Promise.all(files.map((f) => f.text()))
}

export async function benchCandidateAction(
  _: OwnerState,
  form: FormData
): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const id = z.uuid().parse(field(form, "id"))
    const verdict = await benchCandidate(
      id,
      await reportTexts(form, "incumbent"),
      await reportTexts(form, "candidate"),
      owner.id
    )
    revalidatePath(PAGE, "layout")
    return { message: `Benched. Verdict from gate(): ${verdict.verdict}.` }
  } catch (error) {
    if (error instanceof ProposalError) return { error: error.message }
    if (error instanceof z.ZodError) return { error: "Unknown candidate." }
    log.error("candidate bench failed", { error: (error as Error)?.name ?? "error" })
    return { error: "That didn't save." }
  }
}

export async function decideCandidateAction(
  _: OwnerState,
  form: FormData
): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const id = z.uuid().parse(field(form, "id"))
    const decision = z.enum(["approve", "reject"]).parse(field(form, "decision"))
    const reason = z.string().max(500).parse(field(form, "reason"))
    await decideCandidate(id, decision, owner.id, reason)
    revalidatePath(PAGE, "layout")
    return { message: decision === "approve" ? "Approved." : "Rejected." }
  } catch (error) {
    if (error instanceof ProposalError) return { error: error.message }
    if (error instanceof z.ZodError) return { error: "Invalid decision." }
    log.error("candidate decision failed", { error: (error as Error)?.name ?? "error" })
    return { error: "That didn't save." }
  }
}

export async function freezeScoutAction(): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    await freezeScout(owner.id)
    revalidatePath(PAGE, "layout")
    return { message: "The Scout is frozen (harness.scout is off)." }
  } catch (error) {
    log.error("scout freeze failed", { error: (error as Error)?.name ?? "error" })
    return { error: "That didn't save." }
  }
}

/* ──────────────────────────── versions (W11) ──────────────────────────── */

// SELF_EVOLUTION §6, WD-09: canary 10 → 50 → 100 %, promote, one-click
// rollback. Served only with harness.cartridgeOverlay on; each change is audited.
export async function versionAction(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const id = z.uuid().parse(field(form, "id"))
    const op = z
      .enum(["canary-10", "canary-50", "canary-100", "promote", "rollback"])
      .parse(field(form, "op"))
    if (op === "promote") await promoteVersion(id, owner.id)
    else if (op === "rollback") await rollbackVersion(id, owner.id)
    else await canaryVersion(id, Number(op.slice(7)), owner.id)
    revalidatePath(PAGE, "layout")
    return {
      message:
        op === "rollback"
          ? "Rolled back. Devices get the previous version on their next fetch."
          : op === "promote"
            ? "Promoted: every device gets this version (with the overlay on)."
            : `Canary at ${op.slice(7)}% of devices (with the overlay on).`,
    }
  } catch (error) {
    if (error instanceof VersionError) return { error: error.message }
    if (error instanceof z.ZodError) return { error: "Invalid change." }
    log.error("version change failed", { error: (error as Error)?.name ?? "error" })
    return { error: "That didn't save." }
  }
}
