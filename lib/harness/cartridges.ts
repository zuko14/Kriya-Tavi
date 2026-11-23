import { z } from "zod"

import {
  CARTRIDGE_ROLES,
  CONTRACT_NAMES,
  DETECTOR_IDS,
  GATE_IDS,
  cartridgeId,
} from "@/lib/harness/cartridge-ids"
import type { SkillManifest } from "@/lib/skill-library"

// Harness 2.0 role cartridges (docs/kriya-harness/upgrade_2.0/CARTRIDGES.md §2).
// A cartridge is a Kriya default skill (SKILL.md + kriya.json, validated by
// the library's own buildCatalog, unchanged) plus this block, kept in
// skills-harness/cartridges/<id>.json: outside the skill's own folder, because
// the skill loader refuses a folder holding any file it doesn't read
// (lib/skill-engine.ts audit, REAUDIT RA-30). Data only: ids from
// cartridge-ids.ts, short texts and bounds. A cartridge holds no command, URL,
// tool, risk class, mode, limit, price or pass condition, and no field exists
// for one (CARTRIDGES §1).

const shortText = (max: number) => z.string().trim().min(1).max(max)

export const CartridgeFile = z.strictObject({
  id: z.string().regex(/^kriya-role-[a-z]{2,20}$/),
  role: z.enum(CARTRIDGE_ROLES),
  // Contracts this role may write, and those its builders get slices of
  owns: z.array(z.enum(CONTRACT_NAMES)).max(CONTRACT_NAMES.length),
  reads: z.array(z.enum(CONTRACT_NAMES)).max(CONTRACT_NAMES.length),
  // Gate and detector ids from the client's catalogue (GATES.md)
  gates: z.array(z.enum(GATE_IDS)).min(1).max(12),
  detectors: z
    .array(
      z.strictObject({ id: z.enum(DETECTOR_IDS), severity: z.enum(["error", "warn"]) })
    )
    .max(20),
  // Taste the code can't measure: the critic's items, after hard gates pass
  judgement: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
        ask: shortText(200),
        severity: z.enum(["major", "minor"]),
      })
    )
    .max(12),
  // Attempt after which the head tier builds (ARCHITECTURE §5); default 2
  escalateAfter: z.number().int().min(0).max(4).optional(),
  // The cartridge text budget, equal to its manifest's limits.maxChars
  maxPromptChars: z.number().int().min(500).max(6000),
  // Changed-file patterns that point a step at this role (CARTRIDGES §5),
  // simple globs: *, ** and literal names only
  globs: z.array(z.string().regex(/^[A-Za-z0-9_.*/{},-]{1,60}$/)).max(20),
})
export type Cartridge = z.infer<typeof CartridgeFile>

/** The block a device gets beside the skill's catalogue fields (no id: the item carries it). */
export type CartridgeBlock = Omit<Cartridge, "id">

/**
 * Checks every cartridge against its manifest and the others; throws on
 * anything wrong, so a bad cartridge fails the build and the tests.
 */
export function buildCartridges(manifests: SkillManifest[], files: unknown[]) {
  const byManifest = new Map(manifests.map((m) => [m.id, m]))
  const out = new Map<string, Cartridge>()
  const roles = new Set<string>()
  for (const raw of files) {
    const c = CartridgeFile.parse(raw)
    if (c.id !== cartridgeId(c.role))
      throw new Error(`${c.id}: the id must be ${cartridgeId(c.role)}.`)
    if (out.has(c.id)) throw new Error(`The cartridge ${c.id} is listed twice.`)
    if (roles.has(c.role)) throw new Error(`Two cartridges have the role ${c.role}.`)
    const manifest = byManifest.get(c.id)
    if (!manifest) throw new Error(`${c.id} has no skill manifest.`)
    if (manifest.limits.maxChars !== c.maxPromptChars)
      throw new Error(
        `${c.id}: maxPromptChars must equal the manifest's limits.maxChars.`
      )
    if (
      manifest.tools.all.length ||
      manifest.tools.any.length ||
      manifest.tools.uses.length
    )
      throw new Error(`${c.id}: a cartridge needs no Kriya tool.`)
    const ids = c.detectors.map((d) => d.id)
    if (new Set(ids).size !== ids.length)
      throw new Error(`${c.id}: a detector is listed twice.`)
    if (new Set(c.gates).size !== c.gates.length)
      throw new Error(`${c.id}: a gate is listed twice.`)
    const asks = c.judgement.map((j) => j.id)
    if (new Set(asks).size !== asks.length)
      throw new Error(`${c.id}: a judgement item is listed twice.`)
    out.set(c.id, c)
    roles.add(c.role)
  }
  for (const m of manifests)
    if (!out.has(m.id)) throw new Error(`${m.id} has no cartridge block.`)
  return out
}

/** The served block: the file without its id. */
export function cartridgeBlock({ id, ...block }: Cartridge): CartridgeBlock {
  void id
  return block
}
