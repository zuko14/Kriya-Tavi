import { z } from "zod"

// The HarnessProfile schema alone, without node:crypto, so the Flows editor
// can validate a device flow in the browser (docs/kriya-studio/DECISIONS.md SD-14)

export const HarnessProfile = z
  .object({
    version: z.literal(1),
    loop: z.boolean(),
    loopV2: z.boolean(),
    budget: z.boolean(),
    anchor: z.boolean(),
    minimalTools: z.boolean(),
    maxSteps: z.number().int().min(20).max(400),
    turnMinutes: z.number().int().min(5).max(120),
    maxRepeats: z.number().int().min(3).max(30),
  })
  .strict()
  .refine((p) => p.loop || !p.loopV2, { message: "loopV2 needs loop" })
export type HarnessProfile = z.infer<typeof HarnessProfile>

/** Kriya Harness 0.2.0's defaults (U10: loop and budget on) */
export const BASELINE: HarnessProfile = {
  version: 1,
  loop: true,
  loopV2: false,
  budget: true,
  anchor: false,
  minimalTools: false,
  maxSteps: 150,
  turnMinutes: 60,
  maxRepeats: 10,
}
