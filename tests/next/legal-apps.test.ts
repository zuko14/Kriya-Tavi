import { expect, it } from "vitest"

import { LEGAL_DOCS, LEGAL_STATUS, PROCESSORS } from "@/lib/legal"

// NR-8 (draft): the notice says a person's requests go to an app they connect.
// Counsel's answers (NQ-1, NQ-3) are still open, so it stays a labelled draft.
it("the privacy notice lists connected apps as recipients, still a draft", () => {
  const app = PROCESSORS.find((p) => p.name.startsWith("Apps you connect"))
  expect(app?.purpose).toContain("go to that app")
  expect(app?.purpose).toContain("waits for your OK")
  expect(JSON.stringify(LEGAL_DOCS.privacy)).toContain("Apps you connect")
  expect(LEGAL_STATUS.draft).toBe(true)
})
