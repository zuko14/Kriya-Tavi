import { randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { mcpAuthProvider } from "@/lib/connectors"
import { databaseChecks } from "@/lib/readiness"
import { keyId, needsReseal } from "@/lib/secrets"

import { connectedUser } from "../connectors/fixtures"
import { registerFixture } from "../fixtures/mcp/server"

// NR-6 (SECURITY_AND_THREATS §5): a key rotation rehearsed with an app
// connection present. The readiness check counts the app's sealed tokens, a
// refresh during the rotation moves both of them to the new key, and a token
// left on a retired key asks the person to reconnect instead of crashing.

const A = randomBytes(32).toString("base64")
const B = randomBytes(32).toString("base64")
const use = (current: string, previous?: string) => {
  process.env.KRIYA_TOKEN_KEY = current
  if (previous) process.env.KRIYA_TOKEN_KEY_PREVIOUS = previous
  else delete process.env.KRIYA_TOKEN_KEY_PREVIOUS
}
const idOf = (key: string) => `v2_${keyId(Buffer.from(key, "base64"))}`

let pg: Awaited<ReturnType<typeof connectedUser>>["pg"]
let user: string
const query = async (sql: string) => (await pg.query(sql)).rows as never[]
const row = async () =>
  (
    await pg.query<{ access_token: string; refresh_token: string | null }>(
      "select access_token, refresh_token from kriya.mcp_connections where user_id = $1",
      [user]
    )
  ).rows[0]
const sealedCheck = async (key: string) =>
  (await databaseChecks(query, { KRIYA_TOKEN_KEY: key })).find(
    (c) => c.id === "keys.sealed"
  )!

beforeEach(async () => {
  use(A)
  ;({ pg, userId: user } = await connectedUser([]))
  await registerFixture((sql, params) => pg.query(sql, params), "tracker", [
    { name: "search_items", risk: "R0" },
  ])
  const provider = await mcpAuthProvider(user, "tracker")
  await provider.saveTokens({
    access_token: "at-secret-1",
    refresh_token: "rt-secret-1",
    token_type: "Bearer",
    expires_in: 3600,
  })
})
afterEach(() => use(A))

describe("NR-6 key rotation with an app connection", () => {
  it("readiness counts the app's tokens on the old key and never prints one", async () => {
    expect((await sealedCheck(A)).status).toBe("pass")
    use(B, A)
    const stale = await sealedCheck(B)
    expect(stale.status).toBe("warn")
    expect(stale.detail).toContain(`mcp_connections ${idOf(A)} ×2`)
    expect(stale.detail).not.toContain("secret")
  })

  it("a refresh during the rotation moves both tokens to the new key, even when the app sends no new refresh token", async () => {
    use(B, A)
    const provider = await mcpAuthProvider(user, "tracker")
    expect((await provider.tokens())?.access_token).toBe("at-secret-1")
    // The app's refresh answers with a new access token only
    await provider.saveTokens({
      access_token: "at-secret-2",
      token_type: "Bearer",
      expires_in: 3600,
    })
    const after = await row()
    expect(needsReseal(after.access_token)).toBe(false)
    expect(needsReseal(after.refresh_token!)).toBe(false)
    expect((await sealedCheck(B)).status).toBe("pass")
    // Still works once the old key is gone
    use(B)
    const tokens = await (await mcpAuthProvider(user, "tracker")).tokens()
    expect(tokens).toMatchObject({
      access_token: "at-secret-2",
      refresh_token: "rt-secret-1",
    })
  })

  it("a token left on a retired key asks the person to reconnect instead of crashing", async () => {
    use(B)
    const provider = await mcpAuthProvider(user, "tracker")
    await expect(provider.tokens()).rejects.toThrow(/Reconnect it in Account → Apps/)
  })
})
