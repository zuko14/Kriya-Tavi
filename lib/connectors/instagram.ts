import {
  ConnectorError,
  jsonOf,
  META_GRAPH,
  providerFetch,
  readBack,
} from "@/lib/connectors"

// Instagram Graph API (A8) for professional accounts, through the person's
// Meta connection. Publishing is R4 and reads the post back. No Undo until
// RG-10 confirms the API can delete published media (K3).

async function graph<T>(
  userId: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await providerFetch(userId, "meta", `${META_GRAPH}${path}`, init)
  return jsonOf<T>(response, "The Instagram request")
}

// The Instagram professional account linked to the person's Pages
async function account(userId: string) {
  const pages = await graph<{
    data?: { instagram_business_account?: { id: string } }[]
  }>(userId, "/me/accounts?fields=instagram_business_account{id}")
  const id = pages.data?.find((p) => p.instagram_business_account)
    ?.instagram_business_account?.id
  if (!id) {
    throw new ConnectorError(
      "No Instagram professional account is linked to the person's Facebook Pages."
    )
  }
  return id
}

export async function instagramInsights(userId: string, { limit }: { limit: number }) {
  const ig = await account(userId)
  const profile = await graph<{
    username?: string
    followers_count?: number
    media_count?: number
  }>(userId, `/${ig}?fields=username,followers_count,media_count`)
  const media = await graph<{
    data?: {
      id: string
      caption?: string
      media_type?: string
      permalink?: string
      timestamp?: string
      like_count?: number
      comments_count?: number
    }[]
  }>(
    userId,
    `/${ig}/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&limit=${limit}`
  )
  return {
    account: {
      username: profile.username ?? null,
      followers: profile.followers_count ?? null,
      posts: profile.media_count ?? null,
    },
    recent: (media.data ?? []).map((m) => ({
      id: m.id,
      type: m.media_type ?? null,
      caption: (m.caption ?? "").slice(0, 300),
      posted: m.timestamp ?? null,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
      url: m.permalink ?? null,
    })),
  }
}

// One image post: a container, then publish, then read the post back.
// ponytail: images only; reels and carousels need container polling.
export async function instagramPublish(
  userId: string,
  { imageUrl, caption }: { imageUrl: string; caption: string }
) {
  const ig = await account(userId)
  const container = await graph<{ id: string }>(userId, `/${ig}/media`, {
    method: "POST",
    body: { image_url: imageUrl, caption },
  })
  const published = await graph<{ id: string }>(userId, `/${ig}/media_publish`, {
    method: "POST",
    body: { creation_id: container.id },
  })
  const back = await graph<{ id: string; caption?: string; permalink?: string }>(
    userId,
    `/${published.id}?fields=id,caption,permalink`
  )
  return {
    mediaId: published.id,
    url: back.permalink ?? null,
    verification: readBack(
      back.id === published.id && (back.caption ?? "") === caption,
      [
        ...(back.permalink ? [{ kind: "url" as const, value: back.permalink }] : []),
        { kind: "provider_id", value: published.id },
      ],
      "Read back from Instagram: the post is live with this caption."
    ),
  }
}
