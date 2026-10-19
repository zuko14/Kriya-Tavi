import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { instagramInsights, instagramPublish } from "@/lib/connectors/instagram"

import { connectedUser, serve, TOKEN } from "./fixtures"

// Instagram Graph API (A8): parse, publish with read-back, error mapping.

let userId: string
beforeAll(async () => {
  ;({ userId } = await connectedUser(["meta"]))
})
afterEach(() => vi.unstubAllGlobals())

const ACCOUNTS = {
  url: /\/me\/accounts\?fields=instagram_business_account/,
  body: { data: [{ instagram_business_account: { id: "17841400000000001" } }] },
}

describe("instagram", () => {
  it("reads followers and recent posts", async () => {
    serve([
      ACCOUNTS,
      {
        url: /\/17841400000000001\?fields=username/,
        body: { username: "test.studio", followers_count: 1500, media_count: 42 },
      },
      {
        url: /\/17841400000000001\/media\?/,
        body: {
          data: [
            {
              id: "m1",
              caption: "Diwali offer",
              media_type: "IMAGE",
              permalink: "https://www.instagram.com/p/test1/",
              like_count: 80,
              comments_count: 4,
            },
          ],
        },
      },
    ])
    const result = await instagramInsights(userId, { limit: 5 })
    expect(result.account).toEqual({
      username: "test.studio",
      followers: 1500,
      posts: 42,
    })
    expect(result.recent[0]).toMatchObject({ id: "m1", likes: 80, comments: 4 })
  })

  it("publishes an image and verifies the live caption", async () => {
    const calls = serve([
      ACCOUNTS,
      { method: "POST", url: /\/17841400000000001\/media$/, body: { id: "container1" } },
      {
        method: "POST",
        url: /\/17841400000000001\/media_publish$/,
        body: { id: "post1" },
      },
      {
        url: /\/post1\?fields=/,
        body: {
          id: "post1",
          caption: "New menu",
          permalink: "https://www.instagram.com/p/post1/",
        },
      },
    ])
    const result = await instagramPublish(userId, {
      imageUrl: "https://cdn.example.test/menu.jpg",
      caption: "New menu",
    })
    expect(calls[1].body).toEqual({
      image_url: "https://cdn.example.test/menu.jpg",
      caption: "New menu",
    })
    expect(calls[2].body).toEqual({ creation_id: "container1" })
    expect(calls.every((c) => !c.url.includes(TOKEN("meta")))).toBe(true)
    expect(result.verification).toMatchObject({
      status: "verified",
      evidence: expect.arrayContaining([
        { kind: "url", value: "https://www.instagram.com/p/post1/" },
      ]),
    })
  })

  it("a caption that doesn't read back the same is failed", async () => {
    serve([
      ACCOUNTS,
      { method: "POST", url: /\/media$/, body: { id: "c2" } },
      { method: "POST", url: /\/media_publish$/, body: { id: "post2" } },
      { url: /\/post2\?/, body: { id: "post2", caption: "different" } },
    ])
    const result = await instagramPublish(userId, {
      imageUrl: "https://cdn.example.test/a.jpg",
      caption: "New menu",
    })
    expect(result.verification.status).toBe("failed")
  })

  it("passes Meta's own error message through", async () => {
    serve([
      ACCOUNTS,
      {
        method: "POST",
        url: /\/media$/,
        status: 400,
        body: { error: { message: "The image URL could not be fetched.", code: 9004 } },
      },
    ])
    await expect(
      instagramPublish(userId, {
        imageUrl: "https://cdn.example.test/x.jpg",
        caption: "x",
      })
    ).rejects.toThrow(/could not be fetched/)
  })
})
