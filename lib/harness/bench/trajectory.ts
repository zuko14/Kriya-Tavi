import { z } from "zod"

// What a run's own session records say (KRHE's Evidence stage): the client's
// `kriya verify status --json`, read after the agent ends. Counts and a
// verdict from exit codes only; nothing here is what a model claimed. Every
// count is optional so an older client's report still loads.

const count = z.number().int().nonnegative().optional()

const Trajectory = z.object({
  status: z.string().max(40),
  stale: z.boolean().optional(),
  plans: count,
  planned: count,
  open: count,
  passed: count,
  blocked: count,
  recovered: count,
  checkRuns: count,
  failedRuns: count,
  stalled: count,
  builders: count,
  builderSteps: count,
  interrupted: count,
  rollbacks: count,
  earlyFailures: count,
  peakTokens: count,
  classes: z.record(z.string(), z.number()).optional(),
})
export type Trajectory = z.infer<typeof Trajectory>

/** The status command's output, or null when it printed nothing usable */
export function parseTrajectory(output: string): Trajectory | null {
  try {
    const report = JSON.parse(output.trim().split("\n").at(-1) ?? "")
    const parsed = Trajectory.safeParse({
      ...report.trajectory,
      status: report.status,
      stale: report.stale,
    })
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
