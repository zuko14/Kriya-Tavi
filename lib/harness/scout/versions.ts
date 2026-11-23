import { createHash } from "node:crypto"

import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { privileged } from "@/db"
import {
  auditEvents,
  harnessCartridgeCandidates,
  harnessCartridgeOutcomes,
  harnessCartridgeVersions,
} from "@/db/schema"
import { cartridgeBlock, type Cartridge } from "@/lib/harness/cartridges"
import { audit } from "@/lib/owner"

import { loadIncumbent } from "./draft"

// Harness 2.0 W11: cartridge versions (SELF_EVOLUTION §6; WD-09). An
// approved candidate becomes an immutable version. Served only with
// harness.cartridgeOverlay on: the active version, or the canary to devices
// whose bucket sha256(deviceId ‖ versionId) mod 100 is under its share.
// Rollback is one status change; the previous active version comes back.
// The guard rolls a canary back by itself only on enough evidence.

export type CartridgeVersion = typeof harnessCartridgeVersions.$inferSelect
type Version = CartridgeVersion
type Tx = Parameters<Parameters<typeof privileged.transaction>[0]>[0]
type Db = typeof privileged | Tx

export class VersionError extends Error {}

const bump = (v: string) => {
  const [a, b, c] = v.split(".").map(Number)
  return `${a}.${b}.${c + 1}`
}
const newer = (x: string, y: string) => {
  const a = x.split(".").map(Number)
  const b = y.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/**
 * The version an approved candidate becomes: one patch above the newest of
 * the repository's version and every stored one (DATA_MODEL §1). Written in
 * the approval's own transaction.
 */
export async function createVersion(tx: Db, candidateId: string) {
  const [c] = await tx
    .select()
    .from(harnessCartridgeCandidates)
    .where(eq(harnessCartridgeCandidates.id, candidateId))
  if (!c) throw new VersionError("No such candidate.")
  const incumbent = loadIncumbent(c.cartridgeId)
  const stored = await tx
    .select({ version: harnessCartridgeVersions.version })
    .from(harnessCartridgeVersions)
    .where(eq(harnessCartridgeVersions.cartridgeId, c.cartridgeId))
  const newest = stored
    .map((s) => s.version)
    .reduce((m, v) => (newer(v, m) ? v : m), incumbent.version)
  const version = bump(newest)
  const base = incumbent.cartridge
  const cartridge: Cartridge = {
    ...base,
    judgement: c.judgement,
    gates: [...base.gates, ...(c.addedGates as Cartridge["gates"])],
    detectors: [
      ...base.detectors,
      ...c.addedDetectors.map(
        (id) => ({ id, severity: "warn" }) as Cartridge["detectors"][number]
      ),
    ],
  }
  const activation = (incumbent.manifest.activation ?? {}) as { keywords?: string[] }
  const manifest = {
    ...incumbent.manifest,
    version,
    activation: {
      ...activation,
      keywords: [...(activation.keywords ?? []), ...c.addedKeywords],
    },
    cartridge: cartridgeBlock(cartridge),
  }
  const [row] = await tx
    .insert(harnessCartridgeVersions)
    .values({ cartridgeId: c.cartridgeId, version, candidateId, body: c.body, manifest })
    .returning()
  return row
}

/** A device's stable place, 0–99, for one canary version. */
export const canaryBucket = (deviceId: string, versionId: string) =>
  createHash("sha256").update(`${deviceId}\u0000${versionId}`).digest().readUInt32BE(0) %
  100

/**
 * The version each cartridge serves to this device with the overlay on:
 * the canary when the device's bucket is under its share, else the active
 * one; none means the repository's cartridge.
 */
export async function servedVersions(deviceId: string) {
  const live = await privileged
    .select()
    .from(harnessCartridgeVersions)
    .where(inArray(harnessCartridgeVersions.status, ["canary", "active"]))
  const out = new Map<string, Version>()
  for (const v of live.filter((v) => v.status === "active")) out.set(v.cartridgeId, v)
  for (const v of live.filter((v) => v.status === "canary"))
    if (canaryBucket(deviceId, v.id) < v.canaryPct) out.set(v.cartridgeId, v)
  return out
}

export const CANARY_STEPS = [10, 50, 100] as const

const setStatus = (
  tx: Db,
  id: string,
  status: Version["status"],
  extra: Partial<Version> = {}
) =>
  tx
    .update(harnessCartridgeVersions)
    .set({ status, ...extra })
    .where(eq(harnessCartridgeVersions.id, id))

async function versionOf(tx: Db, id: string) {
  const [v] = await tx
    .select()
    .from(harnessCartridgeVersions)
    .where(eq(harnessCartridgeVersions.id, id))
    .for("update")
  if (!v) throw new VersionError("No such version.")
  return v
}

/** Starts or widens a canary: 10 → 50 → 100 percent of devices. */
export async function canaryVersion(id: string, pct: number, actorId: string) {
  if (!(CANARY_STEPS as readonly number[]).includes(pct))
    throw new VersionError("A canary serves 10, 50 or 100 percent of devices.")
  await privileged.transaction(async (tx) => {
    const v = await versionOf(tx, id)
    if (v.status !== "approved" && v.status !== "canary")
      throw new VersionError(
        "Only an approved version or a canary can serve a canary share."
      )
    if (v.status === "canary" && pct <= v.canaryPct)
      throw new VersionError("A canary's share only grows.")
    const [other] = await tx
      .select({ id: harnessCartridgeVersions.id })
      .from(harnessCartridgeVersions)
      .where(
        and(
          eq(harnessCartridgeVersions.cartridgeId, v.cartridgeId),
          eq(harnessCartridgeVersions.status, "canary")
        )
      )
    if (other && other.id !== id)
      throw new VersionError("Another version of this cartridge is already a canary.")
    await setStatus(tx, id, "canary", { canaryPct: pct })
  })
  await audit(
    actorId,
    "harness.version.canary",
    { type: "harness_cartridge_version", id },
    { pct }
  )
}

/** Makes a version the one every device gets; the previous active one is superseded. */
export async function promoteVersion(id: string, actorId: string) {
  await privileged.transaction(async (tx) => {
    const v = await versionOf(tx, id)
    if (v.status !== "approved" && v.status !== "canary")
      throw new VersionError("Only an approved version or a canary can be promoted.")
    await tx
      .update(harnessCartridgeVersions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(harnessCartridgeVersions.cartridgeId, v.cartridgeId),
          eq(harnessCartridgeVersions.status, "active")
        )
      )
    await setStatus(tx, id, "active", { activatedAt: new Date() })
  })
  await audit(actorId, "harness.version.promote", {
    type: "harness_cartridge_version",
    id,
  })
}

/**
 * One click: the version is rolled back. An active one hands back to the
 * version it replaced (or the repository's cartridge if none). The served
 * list, and so its ETag, changes on the next fetch. Nothing is deleted.
 */
export async function rollbackVersion(
  id: string,
  actorId: string | null,
  reason?: string
) {
  await privileged.transaction(async (tx) => {
    const v = await versionOf(tx, id)
    if (v.status === "rolled_back" || v.status === "superseded")
      throw new VersionError("This version isn't served or waiting to be.")
    await setStatus(tx, id, "rolled_back")
    if (v.status !== "active") return
    const [previous] = await tx
      .select({ id: harnessCartridgeVersions.id })
      .from(harnessCartridgeVersions)
      .where(
        and(
          eq(harnessCartridgeVersions.cartridgeId, v.cartridgeId),
          eq(harnessCartridgeVersions.status, "superseded")
        )
      )
      .orderBy(desc(harnessCartridgeVersions.activatedAt))
      .limit(1)
    if (previous) await setStatus(tx, previous.id, "active", { activatedAt: new Date() })
  })
  await privileged.execute(
    sql`insert into kriya.audit_events (actor_id, action, target_type, target_id, details)
        values (${actorId}::uuid, ${actorId ? "harness.version.rollback" : "harness.version.auto_rollback"},
          'harness_cartridge_version', ${id}, ${JSON.stringify(reason ? { reason } : {})}::jsonb)`
  )
}

/* ─────────────────────────────── guard ─────────────────────────────── */

export const GUARD = { minSteps: 100, z: 1.645 } as const

/** A one-sided Wilson bound on a rate (z = 1.645: 95 % one-sided). */
export function wilson(
  successes: number,
  n: number,
  side: "lower" | "upper",
  z: number = GUARD.z
) {
  if (n === 0) return side === "lower" ? 0 : 1
  const p = successes / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return (side === "lower" ? centre - spread : centre + spread) / (1 + (z * z) / n)
}

/**
 * The guard rule (SELF_EVOLUTION §6): with at least 100 counted steps on the
 * canary and on the active version, a canary whose verified rate is below
 * the active one's, by one-sided Wilson bounds that don't overlap, is rolled
 * back. Below that, nothing is automatic.
 */
export function guardVerdict(
  canary: { verified: number; steps: number },
  incumbent: { verified: number; steps: number } | undefined
) {
  if (canary.steps < GUARD.minSteps || !incumbent || incumbent.steps < GUARD.minSteps)
    return "wait" as const
  return wilson(canary.verified, canary.steps, "upper") <
    wilson(incumbent.verified, incumbent.steps, "lower")
    ? ("rollback" as const)
    : ("keep" as const)
}

const totals = async (versionIds: string[]) => {
  if (!versionIds.length) return new Map<string, { verified: number; steps: number }>()
  const rows = await privileged
    .select({
      versionId: harnessCartridgeOutcomes.versionId,
      verified: sql<number>`sum(${harnessCartridgeOutcomes.verified})::int`,
      steps: sql<number>`sum(${harnessCartridgeOutcomes.verified} + ${harnessCartridgeOutcomes.blocked} + ${harnessCartridgeOutcomes.notChecked})::int`,
    })
    .from(harnessCartridgeOutcomes)
    .where(inArray(harnessCartridgeOutcomes.versionId, versionIds))
    .groupBy(harnessCartridgeOutcomes.versionId)
  return new Map(rows.map((r) => [r.versionId, { verified: r.verified, steps: r.steps }]))
}

/** Runs the guard over the canaries of these cartridges (all when omitted); returns the rolled-back ids. */
export async function guardCanaries(cartridgeIds?: string[]) {
  const live = await privileged
    .select()
    .from(harnessCartridgeVersions)
    .where(
      and(
        inArray(harnessCartridgeVersions.status, ["canary", "active"]),
        ...(cartridgeIds
          ? [inArray(harnessCartridgeVersions.cartridgeId, cartridgeIds)]
          : [])
      )
    )
  const counts = await totals(live.map((v) => v.id))
  const rolled: string[] = []
  for (const canary of live.filter((v) => v.status === "canary")) {
    const active = live.find(
      (v) => v.status === "active" && v.cartridgeId === canary.cartridgeId
    )
    const verdict = guardVerdict(
      counts.get(canary.id) ?? { verified: 0, steps: 0 },
      active ? counts.get(active.id) : undefined
    )
    if (verdict !== "rollback") continue
    await rollbackVersion(
      canary.id,
      null,
      "guard: verified rate below the active version's"
    )
    rolled.push(canary.id)
  }
  return rolled
}

/** The owner page's list, newest first, each with its counted outcomes. */
export async function versionOverview() {
  const versions = await privileged
    .select()
    .from(harnessCartridgeVersions)
    .orderBy(desc(harnessCartridgeVersions.createdAt))
    .limit(50)
  const counts = await totals(versions.map((v) => v.id))
  return versions.map((v) => ({
    ...v,
    outcomes: counts.get(v.id) ?? { verified: 0, steps: 0 },
  }))
}

/** The guard's own rollbacks, newest first: the owner page shows them until the owner acts (SELF_EVOLUTION §6). */
export async function autoRollbacks(limit = 5) {
  return privileged
    .select({ versionId: auditEvents.targetId, at: auditEvents.createdAt })
    .from(auditEvents)
    .where(eq(auditEvents.action, "harness.version.auto_rollback"))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
}
