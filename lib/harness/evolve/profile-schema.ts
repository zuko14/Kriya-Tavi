import { z } from "zod"

// The HarnessProfile schema alone, without node:crypto, so the Flows editor
// can validate a device flow in the browser (docs/kriya-studio/DECISIONS.md SD-14)

export const HarnessProfile = z
  .object({
    version: z.literal(1),
    loop: z.boolean(),
    loopV2: z.boolean(),
    // Added after the first profiles were recorded: absent means off
    loopGuard: z.boolean().default(false),
    strictLoop: z.boolean().default(false),
    defensive: z.boolean().default(false),
    recon: z.boolean().default(false),
    jitTools: z.boolean().default(false),
    // Harness 2.0 (W10, upgrade_2.0 CHANGE_IMPACT §2): the workforce switches,
    // and the attempt after which the orchestra's head tier builds
    cartridges: z.boolean().default(false),
    orchestra: z.boolean().default(false),
    gates: z.boolean().default(false),
    critic: z.boolean().default(false),
    milestones: z.boolean().default(false),
    escalateAfter: z.number().int().min(0).max(4).default(2),
    budget: z.boolean(),
    anchor: z.boolean(),
    minimalTools: z.boolean(),
    maxSteps: z.number().int().min(20).max(400),
    turnMinutes: z.number().int().min(5).max(120),
    maxRepeats: z.number().int().min(3).max(30),
  })
  .strict()
  .refine((p) => p.loop || !p.loopV2, { message: "loopV2 needs loop" })
  .refine((p) => p.loop || !(p.loopGuard || p.strictLoop || p.defensive || p.jitTools), {
    message: "loopGuard, strictLoop, defensive and jitTools need loop",
  })
  .refine(
    (p) =>
      p.loop || !(p.cartridges || p.orchestra || p.gates || p.critic || p.milestones),
    { message: "cartridges, orchestra, gates, critic and milestones need loop" }
  )
export type HarnessProfile = z.infer<typeof HarnessProfile>

/** Kriya Harness 0.2.0's defaults (U10: loop and budget on) */
export const BASELINE: HarnessProfile = {
  version: 1,
  loop: true,
  loopV2: false,
  loopGuard: false,
  strictLoop: false,
  defensive: false,
  recon: false,
  jitTools: false,
  cartridges: false,
  orchestra: false,
  gates: false,
  critic: false,
  milestones: false,
  escalateAfter: 2,
  budget: true,
  anchor: false,
  minimalTools: false,
  maxSteps: 150,
  turnMinutes: 60,
  maxRepeats: 10,
}
