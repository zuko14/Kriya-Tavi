import { createHash } from "node:crypto"

import { BASELINE, HarnessProfile } from "./profile-schema"

// KRHE (docs/kriya-harness/RECURSIVE_HARNESS_EVOLUTION.md): a harness
// profile is the part of Kriya Harness an optimizer may vary, as data. It is
// exactly the client's existing switches and turn limits (src/modes.js,
// plugins/budget): every field already has a tested meaning in the client.
// Anything protected (modes, approvals, sandbox, risk classes, egress,
// caps, prices, the gateway) has no field here, and unknown fields are
// refused (KU-ADR-16 E3), so no profile can name one.

export { BASELINE, HarnessProfile }

const KEYS = Object.keys(BASELINE).sort() as (keyof HarnessProfile)[]
// Fields added after profiles were first recorded
const ADDED = new Set<string>([
  "loopGuard",
  "strictLoop",
  "defensive",
  "recon",
  "jitTools",
])

/**
 * A content hash of the profile: the same settings give the same id. A field
 * added later counts only when set, so recorded ids and lessons stay valid.
 */
export const profileId = (p: HarnessProfile) =>
  createHash("sha256")
    .update(
      JSON.stringify(KEYS.filter((k) => !ADDED.has(k) || p[k]).map((k) => [k, p[k]]))
    )
    .digest("hex")
    .slice(0, 12)

const onOff = (v: boolean) => (v ? "on" : "off")

/** The environment the client reads for this profile (flags on the command line would override it) */
export const toEnv = (p: HarnessProfile): Record<string, string> => ({
  KRIYA_LOOP: onOff(p.loop),
  KRIYA_LOOP_V2: onOff(p.loopV2),
  KRIYA_BUDGET: onOff(p.budget),
  KRIYA_ANCHOR: onOff(p.anchor),
  KRIYA_MINIMAL: onOff(p.minimalTools),
  KRIYA_MAX_STEPS: String(p.maxSteps),
  KRIYA_TURN_MINUTES: String(p.turnMinutes),
  KRIYA_MAX_REPEATS: String(p.maxRepeats),
  // Only when on: an older daemon refuses names it doesn't know
  ...(p.loopGuard && { KRIYA_LOOP_GUARD: "on" }),
  ...(p.strictLoop && { KRIYA_STRICT_LOOP: "on" }),
  ...(p.defensive && { KRIYA_DEFENSIVE: "on" }),
  ...(p.recon && { KRIYA_RECON: "on" }),
  ...(p.jitTools && { KRIYA_JIT_TOOLS: "on" }),
})

// Flags beat the environment in the client (switchEnv), so a run pinned to
// a profile must not carry them
export const SWITCH_FLAG =
  /^--(no-)?(loop|loop-v2|loop-guard|strict-loop|defensive|recon|jit-tools|budget|anchor)$/

/** The fields two profiles differ in, with both values */
export const profileDiff = (a: HarnessProfile, b: HarnessProfile) =>
  KEYS.filter((k) => a[k] !== b[k]).map((k) => ({ key: k, from: a[k], to: b[k] }))

/** The environment for a run pinned to `profile`; refuses an agent command that carries a switch flag */
export function pinnedEnv(agentArgs: string[], profile: HarnessProfile) {
  const flag = agentArgs.find((a) => SWITCH_FLAG.test(a))
  if (flag) throw new Error(`--profile sets the switches; take ${flag} out of --agent`)
  return toEnv(profile)
}
