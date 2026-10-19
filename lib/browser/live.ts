import { createHmac, randomUUID } from "node:crypto"

// Live-view tokens, minted by kriya-web after requireUser() and a check that
// the browser session is the person's (BROWSER_AND_LOGIN_PROFILES.md §5).
// browser/live.ts verifies them; the two can't share code (AT-IMP-01), so
// tests/browser/live.test.ts checks they agree.

export const LIVE_TOKEN_SECONDS = 60

export function mintLiveToken(
  sessionId: string,
  userId: string,
  secret: string,
  now = Date.now()
) {
  const payload = Buffer.from(
    JSON.stringify({
      s: sessionId,
      u: userId,
      e: Math.floor(now / 1000) + LIVE_TOKEN_SECONDS,
      n: randomUUID(),
    })
  ).toString("base64url")
  const mac = createHmac("sha256", secret).update(`live:${payload}`).digest("base64url")
  return `${payload}.${mac}`
}
