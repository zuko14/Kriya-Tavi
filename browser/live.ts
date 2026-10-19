import { createHmac, timingSafeEqual } from "node:crypto"

// Live-view tokens (BROWSER_AND_LOGIN_PROFILES.md §5, AT-BRW-12). kriya-web
// mints one after checking the session is the person's (lib/browser/live.ts
// is the other half; the service can't import lib/): an HMAC with
// KRIYA_BROWSER_SECRET over the session id, the user id, an expiry of at
// most 60 s and a nonce. Each token opens one socket, once.

export const LIVE_TOKEN_SECONDS = 60

type Claims = { s: string; u: string; e: number; n: string }

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(`live:${payload}`).digest()

// Nonces already used, kept until their token would have expired anyway
export class UsedTokens {
  private readonly seen = new Map<string, number>()
  take(nonce: string, expires: number, now: number) {
    for (const [key, until] of this.seen) if (until < now) this.seen.delete(key)
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, expires)
    return true
  }
}

// The user the token was minted for, or null: refused before any frame
export function verifyLiveToken(
  token: string,
  sessionId: string,
  secret: string,
  used: UsedTokens,
  now = Date.now()
): string | null {
  const [payload, mac, extra] = token.split(".")
  if (!payload || !mac || extra !== undefined || token.length > 1_000) return null
  const expected = sign(payload, secret)
  const given = Buffer.from(mac, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let claims: Claims
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims
  } catch {
    return null
  }
  const expires = claims.e * 1000
  if (
    claims.s !== sessionId ||
    typeof claims.u !== "string" ||
    typeof claims.n !== "string" ||
    !Number.isFinite(expires) ||
    expires <= now ||
    expires - now > LIVE_TOKEN_SECONDS * 1000
  ) {
    return null
  }
  return used.take(claims.n, expires, now) ? claims.u : null
}
