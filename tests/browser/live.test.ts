import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { UsedTokens, verifyLiveToken } from "@/browser/live"
import { mintLiveToken } from "@/lib/browser/live"

// AT-BRW-12 (token half, no Chromium): kriya-web mints, kriya-browser
// verifies; the two are separate code (AT-IMP-01) and must agree. Wrong
// session, reuse, expiry, tampering and a forged long expiry are refused.

const SECRET = "test-secret-".padEnd(48, "x")
const SESSION = "6f1c3c1e-0000-4000-8000-000000000001"
const USER = "00000000-0000-4000-8000-0000000000aa"

describe("AT-BRW-12 live-view tokens", () => {
  it("a fresh token opens its session once, for its person", () => {
    const used = new UsedTokens()
    const token = mintLiveToken(SESSION, USER, SECRET)
    expect(verifyLiveToken(token, SESSION, SECRET, used)).toBe(USER)
    // Reuse
    expect(verifyLiveToken(token, SESSION, SECRET, used)).toBeNull()
  })

  it("refuses another session, another secret, expiry and tampering", () => {
    const used = new UsedTokens()
    const now = Date.now()
    const token = mintLiveToken(SESSION, USER, SECRET, now)
    expect(verifyLiveToken(token, "another", SECRET, used, now)).toBeNull()
    expect(verifyLiveToken(token, SESSION, "x".repeat(48), used, now)).toBeNull()
    expect(verifyLiveToken(token, SESSION, SECRET, used, now + 61_000)).toBeNull()
    const [payload, mac] = token.split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
    const swapped = Buffer.from(
      JSON.stringify({ ...claims, u: "someone-else" })
    ).toString("base64url")
    expect(verifyLiveToken(`${swapped}.${mac}`, SESSION, SECRET, used, now)).toBeNull()
    expect(verifyLiveToken("", SESSION, SECRET, used, now)).toBeNull()
    expect(verifyLiveToken(`${token}.x`, SESSION, SECRET, used, now)).toBeNull()
    // Untouched, it still works (none of the above used it up)
    expect(verifyLiveToken(token, SESSION, SECRET, used, now)).toBe(USER)
  })

  it("refuses a correctly signed token that lives longer than 60 s", () => {
    const payload = Buffer.from(
      JSON.stringify({
        s: SESSION,
        u: USER,
        e: Math.floor(Date.now() / 1000) + 3600,
        n: "n1",
      })
    ).toString("base64url")
    const mac = createHmac("sha256", SECRET).update(`live:${payload}`).digest("base64url")
    expect(
      verifyLiveToken(`${payload}.${mac}`, SESSION, SECRET, new UsedTokens())
    ).toBeNull()
  })
})
