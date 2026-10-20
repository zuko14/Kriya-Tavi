// One controlled Exotel verification call (voice phase 5, account checks
// X1, X3, X5, X9). Places exactly one call from EXOTEL_CALLER_ID to a number
// in KRIYA_VOICE_TEST_NUMBERS through lib/voice/exotel.ts, then polls the
// call-details API until it ends. No database, no retries, no status
// callback (it needs a public https URL); numbers are never printed.
//
//   KRIYA_VOICE_LIVE=1 KRIYA_VOICE_TEST_NUMBERS=+91XXXXXXXXXX \
//     npx tsx --env-file=.env scripts/exotel-test-call.ts --to +91XXXXXXXXXX --yes
//
// Needs EXOTEL_FLOW_URL: an App Bazaar flow (e.g. a Greeting applet saying
// "This is a Kriya test call") as http://my.exotel.com/<sid>/exoml/start_voice/<app_id>

import { randomUUID } from "node:crypto"

import { exotelConfigFromEnv, exotelTelephony } from "@/lib/voice/exotel"

const RING_SECONDS = 30
const MAX_SECONDS = 60
const POLL_MS = 5_000
const GIVE_UP_MS = 5 * 60_000
const FINAL = new Set(["completed", "busy", "no_answer", "failed", "canceled"])

const fail = (message: string): never => {
  console.error(`refused: ${message}`)
  process.exit(1)
}
const mask = (n: string) => `***${n.slice(-4)}`

const args = process.argv.slice(2)
const to = args[args.indexOf("--to") + 1] ?? ""
if (!args.includes("--to") || !/^\+91[6-9]\d{9}$/.test(to)) {
  fail("--to must be an Indian mobile in E.164, e.g. +919876543210")
}
if (process.env.KRIYA_VOICE_LIVE !== "1") fail("KRIYA_VOICE_LIVE=1 is not set")
const allowed = (process.env.KRIYA_VOICE_TEST_NUMBERS ?? "")
  .split(",")
  .map((n) => n.trim())
if (!allowed.includes(to)) fail(`${mask(to)} is not in KRIYA_VOICE_TEST_NUMBERS`)
const config = exotelConfigFromEnv()
if (!config) {
  fail(
    "set EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_SUBDOMAIN and EXOTEL_FLOW_URL"
  )
}
const callerId =
  process.env.EXOTEL_CALLER_ID?.trim() || fail("EXOTEL_CALLER_ID is not set")

console.log(
  `One call: ${mask(callerId)} -> ${mask(to)} via ${config!.host}, ring ${RING_SECONDS}s, cut off at ${MAX_SECONDS}s`
)
if (!args.includes("--yes")) fail("dry run; add --yes to place the call")

const exotel = exotelTelephony(config!)
const attemptId = `manual-${randomUUID()}`
const { providerCallId } = await exotel.placeCall({
  attemptId,
  to,
  callerId,
  streamUrl: "",
  statusUrl: "",
  ringTimeoutSeconds: RING_SECONDS,
  maxDurationSeconds: MAX_SECONDS,
})
console.log(`placed: CallSid ${providerCallId} (CustomField ${attemptId})`)

let last = ""
const started = Date.now()
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  const call = await exotel.getCall(providerCallId).catch((error: Error) => {
    console.warn(`details unavailable: ${error.message}`)
    return null
  })
  if (call && call.status !== last) {
    last = call.status
    console.log(`status: ${call.status}`)
  }
  if (call && FINAL.has(call.status)) {
    const raw = (call.raw as { Call?: Record<string, unknown> }).Call ?? {}
    // Duration and Price settle about two minutes after the call; rerun
    // the details lookup later for billing (X8)
    console.log({
      status: call.status,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      billableSeconds: call.billableSeconds,
      exotelStatus: raw.Status,
      price: raw.Price,
      details: raw.Details,
    })
    break
  }
  if (Date.now() - started > GIVE_UP_MS) {
    console.warn("no final status after 5 minutes; check the Exotel dashboard")
    break
  }
}
