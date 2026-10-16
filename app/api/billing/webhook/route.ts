import {
  applyEvent,
  verifyRazorpaySignature,
  type SubscriptionEvent,
} from "@/lib/billing"
import { log } from "@/lib/log"

// Razorpay webhooks. Verified by HMAC over the exact raw body, deduplicated
// by Razorpay's event id. A 2xx tells Razorpay to stop retrying, so only a
// processing failure answers 500.
export async function POST(request: Request) {
  const raw = await request.text()
  if (raw.length > 256_000) return new Response("Too large", { status: 413 })
  if (!verifyRazorpaySignature(raw, request.headers.get("x-razorpay-signature"))) {
    log.warn("billing webhook with a bad signature")
    return new Response("Invalid signature", { status: 400 })
  }
  let event: SubscriptionEvent
  try {
    event = JSON.parse(raw) as SubscriptionEvent
  } catch {
    return new Response("Malformed", { status: 400 })
  }
  const eventId =
    request.headers.get("x-razorpay-event-id") ??
    `${event.event}:${event.payload?.subscription?.entity?.id}:${event.created_at}`
  try {
    const result = await applyEvent("razorpay", eventId, event)
    log.info("billing webhook", { event: event.event, result })
    return Response.json({ ok: true, result })
  } catch (error) {
    log.error("billing webhook failed", { event: event.event, error })
    return new Response("Processing failed", { status: 500 })
  }
}
