import { describe, expect, it } from "vitest"

import { safeNext } from "@/lib/redirect"

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/a/x/y?tab=1#end")).toBe("/a/x/y?tab=1#end")
    expect(safeNext("/onboarding")).toBe("/onboarding")
  })

  it.each([
    null,
    "",
    "home",
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "\t//evil.com",
    "/%0a/evil.com/..",
    "javascript:alert(1)",
  ])("never leaves the site for %j", (value) => {
    const result = safeNext(value)
    expect(new URL(result, "https://kriya.app").origin).toBe("https://kriya.app")
  })
})
