import { clientIp, allow } from "@/lib/rate-limit"
import { ipHash, openShare, snapshotUrl } from "@/lib/share"

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
}

// The shared snapshot (K8): a fresh 60 s link while the share is live;
// anything else is a plain 404 (AT-SHR-01)
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ token: string }> }
) {
  const ip = await clientIp()
  if (!(await allow(`share:${ipHash(ip) ?? ip}`, 60, 60))) {
    return new Response("Too many requests. Try again in a minute.", {
      status: 429,
      headers: HEADERS,
    })
  }
  const share = await openShare((await ctx.params).token)
  const url = share ? await snapshotUrl(share) : null
  if (!url) return new Response("Not found.", { status: 404, headers: HEADERS })
  return new Response(null, { status: 303, headers: { ...HEADERS, location: url } })
}
