import { log } from "@/lib/log"
import { handleStatusWebhook } from "@/lib/voice/verify"

// Telephony status webhooks (API_AND_EXECUTION_CONTRACTS §4). Exempt from
// the Origin check in proxy.ts; authorized instead by the unguessable
// per-attempt token in the path (only its hash is stored). Final statuses
// are checked with the provider's API before they count. A 2xx stops the
// provider's retries, so only our own failure answers 500.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params
  const raw = await request.text()
  if (raw.length > 64_000) return new Response("Too large", { status: 413 })
  try {
    const { status } = await handleStatusWebhook(token, raw, request.headers)
    return new Response(null, { status })
  } catch (error) {
    log.error("voice webhook failed", { error })
    return new Response("Processing failed", { status: 500 })
  }
}
