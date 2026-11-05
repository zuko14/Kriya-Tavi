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

/** A content hash of the profile: the same settings give the same id */
export const profileId = (p: HarnessProfile) =>
  createHash("sha256")
    .update(JSON.stringify(KEYS.map((k) => [k, p[k]])))
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
})

// Flags beat the environment in the client (switchEnv), so a run pinned to
// a profile must not carry them
export const SWITCH_FLAG = /^--(no-)?(loop|loop-v2|budget|anchor)$/

/** The fields two profiles differ in, with both values */
export const profileDiff = (a: HarnessProfile, b: HarnessProfile) =>
  KEYS.filter((k) => a[k] !== b[k]).map((k) => ({ key: k, from: a[k], to: b[k] }))

/** The environment for a run pinned to `profile`; refuses an agent command that carries a switch flag */
export function pinnedEnv(agentArgs: string[], profile: HarnessProfile) {
  const flag = agentArgs.find((a) => SWITCH_FLAG.test(a))
  if (flag) throw new Error(`--profile sets the switches; take ${flag} out of --agent`)
  return toEnv(profile)
}
