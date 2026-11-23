// Harness 2.0 role cartridges (docs/kriya-harness/upgrade_2.0/CARTRIDGES.md):
// the ids a cartridge may name. Pure, safe for any bundle. This file is the
// source of truth: scripts/harness-contract.ts exports it into
// docs/kriya-harness/contract.json, and the client copies that into its own
// contract/ folder, so server and client agree on every id.

export const CARTRIDGE_ROLES = [
  "frontend",
  "designer",
  "backend",
  "fullstack",
  "mobile",
  "game",
  "devops",
  "cloud",
  "systems",
  "data",
  "ml",
  "security",
  "qa",
  "sdet",
  "database",
  // Harness 2.0 W13 (WD-17): the sixteenth role
  "graphics",
] as const
export type CartridgeRole = (typeof CARTRIDGE_ROLES)[number]

// GATES.md §3. W1 only names them; the client builds the gates in W3–W6
export const GATE_IDS = [
  "G-CONTRACT",
  "G-DETECT",
  "G-UI",
  "G-A11Y",
  "G-STACK",
  "G-API",
  "G-TENANT",
  "G-SAST",
  "G-SECRETS",
  "G-FLAKE",
  "G-TRACE",
  "G-DATA",
  "G-EVAL",
  "G-SAN",
  "G-IAC",
  "G-SIM",
  "G-SIM-HEADLESS",
  // W13 (WD-17): THREE_D_AND_CREATIVE.md §4
  "G-3D",
] as const

// CARTRIDGES.md §3–4: fixed static checks the client implements in W3/W6
export const DETECTOR_IDS = [
  "FE-HEX",
  "FE-PX",
  "FE-IMG-ALT",
  "FE-CLICK-DIV",
  "FE-FETCH-EFFECT",
  "FE-GLASS-CONTENT",
  "FE-GLASS-FALLBACK",
  "FE-TROPE",
  "FE-FONT-LICENCE",
  "BE-SQL-INTERP",
  "BE-EMPTY-CATCH",
  "BE-NO-TIMEOUT",
  "BE-LOG-SECRET",
  "FS-DTO-DUP",
  "MB-SYNC-IO",
  "MB-HARDCODE-DIM",
  "GM-ALLOC-TICK",
  "GM-DT-MISSING",
  "OPS-LATEST",
  "OPS-SECRET-ENV",
  "OPS-MIGRATE-LOCK",
  "CL-IAM-STAR",
  "CL-PUBLIC",
  "SY-UNSAFE-NOCOMMENT",
  "SY-SPIN",
  "DT-INSERT-NOKEY",
  "ML-FIT-TEST",
  "ML-SEED",
  "SEC-BODY-ID",
  "SEC-EVAL",
  "QA-ONLY",
  "QA-SKIP",
  "SD-SLEEP",
  "SD-XPATH",
  "DB-NO-RLS",
  "DB-FK-NOINDEX",
  "DB-DROP",
  // W13 (WD-17): THREE_D_AND_CREATIVE.md §2
  "GX-COLOR",
  "GX-ALLOC-LOOP",
  "GX-NO-DISPOSE",
  "GX-DPR",
  "FE-ASSET-LICENCE",
] as const

// ORCHESTRA.md §5
export const CONTRACT_NAMES = [
  "api",
  "schema",
  "auth_matrix",
  "design_tokens",
  "component_states",
  "threat_model",
  // W13 (WD-17): the designer's art direction for 3D (THREE_D_AND_CREATIVE.md §3)
  "scene_direction",
] as const

export const CARTRIDGE_PREFIX = "kriya-role-"
export const cartridgeId = (role: CartridgeRole) => `${CARTRIDGE_PREFIX}${role}`
