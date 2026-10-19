import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { authorizeUrl, disconnect, exchangeCode } from "@/lib/connectors"

import { connectedUser, serve, TOKEN } from "./fixtures"

// Connecting GitHub and Meta (A8). Existing Google and Notion paths are
// covered by tests/connectors.test.ts, unchanged.

let pg: Awaited<ReturnType<typeof connectedUser>>["pg"]
let userId: string
beforeAll(async () => {
  ;({ pg, userId } = await connectedUser(["github", "meta"]))
  process.env.GITHUB_CLIENT_ID = "gh-client"
  process.env.GITHUB_CLIENT_SECRET = "gh-secret"
  process.env.META_APP_ID = "meta-app"
  process.env.META_APP_SECRET = "meta-secret"
})
afterEach(() => vi.unstubAllGlobals())

describe("github", () => {
  it("asks no scope: a GitHub App's repositories are picked on install", () => {
    const url = new URL(
      authorizeUrl("github", {
        state: "s",
        redirectUri: "https://kriya.test/cb",
        services: [],
      })
    )
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("scope")).toBeNull()
    expect(url.searchParams.get("owner")).toBeNull()
  })

  it("refuses a 200 answer that carries an error instead of a token", async () => {
    serve([
      {
        method: "POST",
        url: /^https:\/\/github\.com\/login\/oauth\/access_token$/,
        body: { error: "bad_verification_code", error_description: "The code is wrong." },
      },
    ])
    await expect(exchangeCode("github", "code", "https://kriya.test/cb")).rejects.toThrow(
      /Connecting GitHub failed: The code is wrong/
    )
  })

  it("keeps the login as the account and no refresh token", async () => {
    serve([
      {
        method: "POST",
        url: /^https:\/\/github\.com\/login\/oauth\/access_token$/,
        body: { access_token: "gho_test", token_type: "bearer", scope: "" },
      },
      { url: /^https:\/\/api\.github\.com\/user$/, body: { login: "test-dev" } },
    ])
    const tokens = await exchangeCode("github", "code", "https://kriya.test/cb")
    expect(tokens).toEqual({
      accessToken: "gho_test",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      account: "test-dev",
    })
  })
})

describe("meta", () => {
  it("asks for the Instagram publishing permissions", () => {
    const url = new URL(
      authorizeUrl("meta", {
        state: "s",
        redirectUri: "https://kriya.test/cb",
        services: [],
      })
    )
    expect(url.searchParams.get("scope")?.split(",")).toEqual(
      expect.arrayContaining(["instagram_basic", "instagram_content_publish"])
    )
  })

  it("trades the code for a long-lived token and records granted permissions", async () => {
    const calls = serve([
      { url: /oauth\/access_token\?.*code=code/, body: { access_token: "short" } },
      {
        url: /oauth\/access_token\?.*grant_type=fb_exchange_token/,
        body: { access_token: "long", expires_in: 5_184_000 },
      },
      {
        url: /\/me\/permissions$/,
        body: {
          data: [
            { permission: "instagram_basic", status: "granted" },
            { permission: "instagram_content_publish", status: "declined" },
          ],
        },
      },
      {
        url: /\/me\/accounts\?/,
        body: { data: [{}, { instagram_business_account: { username: "test.studio" } }] },
      },
    ])
    const tokens = await exchangeCode("meta", "code", "https://kriya.test/cb")
    expect(tokens.accessToken).toBe("long")
    expect(tokens.scopes).toEqual(["instagram_basic"])
    expect(tokens.account).toBe("test.studio")
    expect(tokens.expiresAt).toBeInstanceOf(Date)
    // After the exchange the token travels only in the Authorization header
    expect(calls[2].url).not.toContain("long")
    expect(calls[2].headers.authorization).toBe("Bearer long")
  })

  it("says so when no Instagram professional account is linked", async () => {
    serve([
      { url: /code=code/, body: { access_token: "short" } },
      { url: /fb_exchange_token/, body: { access_token: "long" } },
      { url: /\/me\/permissions$/, body: { data: [] } },
      { url: /\/me\/accounts\?/, body: { data: [{}] } },
    ])
    await expect(exchangeCode("meta", "code", "https://kriya.test/cb")).rejects.toThrow(
      /No Instagram professional account/
    )
  })
})

describe("disconnect", () => {
  it("revokes GitHub's grant and Meta's permissions, then forgets the tokens", async () => {
    const calls = serve([
      {
        method: "DELETE",
        url: /^https:\/\/api\.github\.com\/applications\/gh-client\/grant$/,
        status: 204,
      },
      { method: "DELETE", url: /\/me\/permissions$/, body: { success: true } },
    ])
    await disconnect(userId, "github")
    await disconnect(userId, "meta")
    expect(calls[0].body).toEqual({ access_token: TOKEN("github") })
    expect(calls[1].headers.authorization).toBe(`Bearer ${TOKEN("meta")}`)
    const { rows } = await pg.query(
      "select provider from kriya.connections where user_id = $1",
      [userId]
    )
    expect(rows).toEqual([])
  })
})
