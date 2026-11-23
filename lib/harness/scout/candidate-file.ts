import { createHash } from "node:crypto"

import { z } from "zod"

// Harness 2.0 W9: the file the owner downloads to bench a candidate
// (SELF_EVOLUTION §3, REAUDIT RA-11): the candidate's text and its sha256,
// read locally by the bench. No token and no server route are involved.
// Pure, so the bench command can load it without the database.

export const CandidateFile = z.strictObject({
  kind: z.literal("kriya-cartridge-candidate"),
  candidateId: z.uuid(),
  cartridgeId: z.string().regex(/^kriya-role-[a-z]{2,20}$/),
  baseVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  body: z.string().min(1).max(6000),
  judgement: z
    .array(
      z.strictObject({
        id: z.string(),
        ask: z.string(),
        severity: z.enum(["major", "minor"]),
      })
    )
    .max(12),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type CandidateFile = z.infer<typeof CandidateFile>

export const bodySha256 = (body: string) =>
  createHash("sha256").update(body).digest("hex")

/** Parses a candidate file and checks its hash; throws on anything wrong. */
export function readCandidateFile(text: string): CandidateFile {
  const file = CandidateFile.parse(JSON.parse(text))
  if (bodySha256(file.body) !== file.sha256)
    throw new Error("The candidate's text doesn't match its sha256.")
  return file
}

/** What a bench report records about the candidate it ran (absent for the incumbent arm). */
export const ReportCandidate = z.strictObject({
  id: z.uuid(),
  cartridgeId: z.string().regex(/^kriya-role-[a-z]{2,20}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
