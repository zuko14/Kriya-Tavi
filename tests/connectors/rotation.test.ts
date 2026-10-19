import { randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { accessToken, ConnectorError, disconnect, saveConnection } from "@/lib/connectors"
import { needsReseal, open } from "@/lib/secrets"

import { connectedUser, serve } from "./fixtures"

// Connection tokens across a key rotation (A11, owner 2026-10-19): a Google
// refresh moves both tokens to the new key; a token on a retired key asks
// the person to reconnect; Disconnect works even when the token won't open.

const A = randomBytes(32).toString("base64")
const B = randomBytes(32).toString("base64")
const use = (current: string, previous?: string) => {
  process.env.KRIYA_TOKEN_KEY = current
  if (previous) process.env.KRIYA_TOKEN_KEY_PREVIOUS = previous
  else delete process.env.KRIYA_TOKEN_KEY_PREVIOUS
}

let pg: Awaited<ReturnType<typeof connectedUser>>["pg"]
let userId: string
const row = async (provider = "google") =>
  (
    await pg.query<{ access_token: string; refresh_token: string | null }>(
      "select access_token, refresh_token from kriya.connections where user_id = $1 and provider = $2",
      [userId, provider]
    )
  ).rows[0]

beforeEach(async () => {
  use(A)
  ;({ pg, userId } = await connectedUser(["github"]))
  process.env.GOOGLE_CLIENT_ID = "g-client"
  process.env.GOOGLE_CLIENT_SECRET = "g-secret"
  // An expired access token, so the next use refreshes
  await saveConnection(userId, "google", {
    accessToken: "ya29.old",
    refreshToken: "1//refresh",
    expiresAt: new Date(Date.now() - 1000),
    scopes: [],
    account: "test@example.com",
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  use(A)
})

describe("connection tokens across a key rotation", () => {
  it("a Google refresh during a rotation re-seals both tokens with the new key", async () => {
    use(B, A)
    const calls = serve([
      {
        method: "POST",
        url: /oauth2\.googleapis\.com\/token$/,
        body: { access_token: "ya29.new", expires_in: 3600 },
      },
    ])
    expect(await accessToken(userId, "google")).toBe("ya29.new")
    expect(String(calls[0].body)).toContain("refresh_token=1%2F%2Frefresh")
    const after = await row()
    expect(needsReseal(after.access_token)).toBe(false)
    expect(needsReseal(after.refresh_token!)).toBe(false)
    // Still works once the old key is gone
    use(B)
    expect(open(after.refresh_token!, `${userId}:google`)).toBe("1//refresh")
  })

  it("a token on a retired key asks the person to reconnect instead of crashing", async () => {
    use(B)
    serve([])
    await expect(accessToken(userId, "github")).rejects.toBeInstanceOf(ConnectorError)
    await expect(accessToken(userId, "github")).rejects.toThrow(/Reconnect GitHub/)
    await expect(accessToken(userId, "google")).rejects.toThrow(/Reconnect Google/)
  })

  it("a missing key is still a platform error, not a reconnect prompt", async () => {
    delete process.env.KRIYA_TOKEN_KEY
    await expect(accessToken(userId, "github")).rejects.toThrow(/KRIYA_TOKEN_KEY/)
  })

  it("Disconnect deletes a connection whose token won't open, without calling the provider", async () => {
    use(B)
    const calls = serve([])
    await disconnect(userId, "google")
    await disconnect(userId, "github")
    expect(calls).toEqual([])
    const { rows } = await pg.query(
      "select provider from kriya.connections where user_id = $1",
      [userId]
    )
    expect(rows).toEqual([])
  })
})
