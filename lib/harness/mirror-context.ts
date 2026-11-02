// The session mirror's label (track H, H6, HD-09). Every mirrored turn
// starts with it, so the person sees where the text came from and
// untrustedSeen (lib/agent/tools.ts) treats it as untrusted content: the
// laptop agent may have read pages written by anyone (owner decision
// 2026-11-01). Pure, so lib/agent/tools.ts can import it, as it does
// ROOM_CONTEXT.

export const MIRROR_CONTEXT = "Mirrored from Kriya Harness"

export const mirrorLabel = (mode: "summary" | "full") => `*${MIRROR_CONTEXT} (${mode})*`
