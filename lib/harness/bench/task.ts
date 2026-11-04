import { createHash } from "node:crypto"

import { z } from "zod"

// KriyaBench tasks (H13, ENGINE_AND_EVOLUTION §4.3). A task is a small
// repository, a job for the agent and a verify command; it counts as passed
// only from that command's exit code, never from what the agent says.

// Relative, inside the task's folder: no "..", no absolute paths
const relPath = z
  .string()
  .regex(/^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._-][A-Za-z0-9._/-]{0,119}$/)

export const benchTaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,60}$/),
    kind: z.enum(["fix", "feature", "context", "refactor", "tests", "probe"]),
    // multi: several distinct parts, visible tests plus a hidden grader (H14c);
    // cap: the capability set (harness upgrade U6)
    level: z.enum(["easy", "hard", "multi", "cap"]),
    prompt: z.string().min(10).max(2000),
    files: z.record(relPath, z.string().max(20_000)),
    // Tests and checkers, restored before the verify command so the task is
    // graded on the originals; editing them (e.g. adding cases) is reported
    // as `tampered` but doesn't fail the task (owner, 2026-11-04: "Grade on
    // originals"). Default: every *.test.js
    protect: z.array(relPath).optional(),
    // Files the task forbids changing (the code under test in a write-tests
    // task, package.json in a no-new-dependency probe): restored too, and a
    // change fails the task
    constraints: z.array(relPath).optional(),
    // Tests and checkers the agent never sees: in the folder only while the
    // verify command runs, so the agent works from the prompt and the code
    hidden: z.record(relPath, z.string().max(20_000)).optional(),
    // The reference fix: files it replaces. Proves the task can be passed
    solution: z.record(relPath, z.string().max(20_000)),
    // A plausible wrong fix that passes the visible tests and must fail the
    // task (HU-BEN-04): proves the grader catches it
    exploit: z.record(relPath, z.string().max(20_000)).optional(),
    verify: z.object({
      // No shell: argv, with "node" meaning this Node
      command: z.array(z.string().min(1)).min(1),
      timeoutSeconds: z.number().int().min(1).max(600),
    }),
    // Probes: a value that must never leave .env (not in another file, not in
    // the agent's output)
    bait: z.string().min(12).optional(),
  })
  .refine((t) => (t.protect ?? []).every((f) => f in t.files), {
    message: "every protected file is one of the task's files",
  })
  .refine((t) => (t.constraints ?? []).every((f) => f in t.files), {
    message: "every constraint file is one of the task's files",
  })
  .refine((t) => Object.keys(t.hidden ?? {}).every((f) => !(f in t.files)), {
    message: "a hidden file isn't also one of the task's files",
  })

export type BenchTask = z.infer<typeof benchTaskSchema>

// Runs are comparable only on the same seed set: this names it
export function seedVersion(tasks: BenchTask[]) {
  return createHash("sha256").update(JSON.stringify(tasks)).digest("hex").slice(0, 12)
}
