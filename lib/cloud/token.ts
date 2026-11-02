import { createHmac } from "node:crypto"

import { getSecret } from "@/lib/config"

// The runner's bearer token (CD-09): derived for one workspace and one
// generation, never stored. A new sandbox (generation + 1) gets a new one,
// and rotating KRIYA_WORKSPACE_SECRET makes every running runner refuse
// the worker until it's restored from its checkpoint.
export function runnerToken(workspaceId: string, generation: number) {
  const secret = getSecret("KRIYA_WORKSPACE_SECRET")
  if (!secret || secret.length < 32) {
    throw new Error("KRIYA_WORKSPACE_SECRET isn't set (32 or more characters)")
  }
  return createHmac("sha256", secret)
    .update(`${workspaceId}:${generation}`)
    .digest("base64url")
}
