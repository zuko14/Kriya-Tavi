import { ConnectorError, jsonOf, providerFetch } from "@/lib/connectors"

// YouTube Data API (A8) on the person's Google connection, with the opt-in
// youtube.readonly scope: their channel's numbers and recent uploads. Upload
// waits for Files (A5), which gives it something to upload.

const YOUTUBE = "https://www.googleapis.com/youtube/v3"

type Stats = { viewCount?: string; subscriberCount?: string; videoCount?: string }

async function yt<T>(userId: string, path: string, params: Record<string, string>) {
  const response = await providerFetch(
    userId,
    "google",
    `${YOUTUBE}/${path}?${new URLSearchParams(params)}`
  )
  if (response.status === 403) {
    throw new ConnectorError(
      "YouTube refused this: YouTube access wasn't granted, or today's API quota is used up."
    )
  }
  return jsonOf<T>(response, "The YouTube request")
}

const count = (value: string | undefined) => (value === undefined ? null : Number(value))

export async function youtubeStats(userId: string, { limit }: { limit: number }) {
  const channels = await yt<{
    items?: {
      id: string
      snippet?: { title?: string }
      statistics?: Stats & { hiddenSubscriberCount?: boolean }
      contentDetails?: { relatedPlaylists?: { uploads?: string } }
    }[]
  }>(userId, "channels", { part: "snippet,statistics,contentDetails", mine: "true" })
  const channel = channels.items?.[0]
  if (!channel) throw new ConnectorError("This Google account has no YouTube channel.")

  const uploads = channel.contentDetails?.relatedPlaylists?.uploads
  const playlist = uploads
    ? await yt<{ items?: { contentDetails?: { videoId?: string } }[] }>(
        userId,
        "playlistItems",
        { part: "contentDetails", playlistId: uploads, maxResults: String(limit) }
      )
    : { items: [] }
  const ids = (playlist.items ?? []).flatMap((i) =>
    i.contentDetails?.videoId ? [i.contentDetails.videoId] : []
  )
  const videos = ids.length
    ? await yt<{
        items?: {
          id: string
          snippet?: { title?: string; publishedAt?: string }
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }
        }[]
      }>(userId, "videos", { part: "snippet,statistics", id: ids.join(",") })
    : { items: [] }

  return {
    channel: {
      id: channel.id,
      title: channel.snippet?.title ?? null,
      views: count(channel.statistics?.viewCount),
      subscribers: channel.statistics?.hiddenSubscriberCount
        ? null
        : count(channel.statistics?.subscriberCount),
      videos: count(channel.statistics?.videoCount),
    },
    recent: (videos.items ?? []).map((v) => ({
      id: v.id,
      title: v.snippet?.title ?? null,
      published: v.snippet?.publishedAt ?? null,
      views: count(v.statistics?.viewCount),
      likes: count(v.statistics?.likeCount),
      comments: count(v.statistics?.commentCount),
      url: `https://www.youtube.com/watch?v=${v.id}`,
    })),
  }
}
