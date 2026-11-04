import { randomUUID } from "node:crypto"

import type { Tier } from "@/db/schema"
import type { DeviceUser } from "@/lib/auth"
import { getSecret, getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"
import { ChatRequest } from "@/lib/harness/contract"
import {
  readUsage,
  reserve,
  settle,
  settleAborted,
  settleFailed,
  upperEstimateMicroUsd,
  type UpstreamUsage,
} from "@/lib/harness/metering"
import { outputCap } from "@/lib/harness/model-limits"
import { fail, readBody } from "@/lib/harness/route"
import { fallbackModel, modelForTier, modelPrices } from "@/lib/models"
import { applyMarkup, parseRate, usdToInr } from "@/lib/money"
import { log } from "@/lib/log"
import { isTier } from "@/lib/tiers"

// The Kriya Harness model gateway (HD-06, ARCHITECTURE §3.2): an
// OpenAI-compatible /chat/completions for signed-in devices. Only the
// plan's tier aliases are accepted and mapped to the owner's tier models;
// the spend is reserved in SQL before anything is sent; the answer streams
// back unchanged except `model`, which reports the alias; the final usage
// chunk settles the reservation. Logs carry ids, statuses and timings only:
// never a prompt, an answer or a tool (HD-17).

// Kriya routes; a client can't pick providers, models or an identity, nor
// add cost the reservation didn't estimate: several answers (`n`), paid
// plugins or web search (re-audit 2026-11-02)
const STRIPPED = [
  "user",
  "provider",
  "models",
  "route",
  "max_completion_tokens",
  "n",
  "plugins",
  "web_search_options",
]

const upstreamUrl = () =>
  `${(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "")}/chat/completions`

// Rate limits, overload and outages are worth one try on the fallback model
const retryable = (status: number) => status === 429 || status >= 500

// A provider's "the conversation is too long" (OpenRouter and the backends it
// routes to word it differently). DSH compacts and retries only when it can
// recognise the refusal, so it gets a code it reads; the provider's text
// itself never leaves the server (it can quote the request)
const OVERFLOW =
  /context[_ ](length|window)|maximum context|prompt (is )?too long|too many tokens|request_too_large|exceeds the (available )?context|input (is )?too long|longer than the model/i

async function overflowed(res: Response) {
  if (res.status !== 400 && res.status !== 413) return false
  const text = await res.text().catch(() => "")
  return OVERFLOW.test(text.slice(0, 8192))
}

export async function chatCompletion(request: Request, device: DeviceUser) {
  if ((await getSetting("harness.gateway")) !== "on")
    return fail(403, "harness_off", "The Kriya Harness model gateway is off.")
  const plan = await getPlan(device.id)
  if (Number(plan.harnessMonthlyMicroInr) <= 0)
    return fail(403, "plan_not_allowed", "Your plan doesn't include Kriya Harness.")
  const body = await readBody(request, ChatRequest)
  if (body instanceof Response) return body
  const alias = body.model
  if (!isTier(alias) || !plan.allowedTiers.includes(alias))
    return fail(
      400,
      "tier_not_allowed",
      "Use a model level your plan includes (see /models)."
    )
  const apiKey = getSecret("OPENROUTER_API_KEY")
  if (!apiKey) return fail(503, "upstream_unavailable", "The model service isn't set up.")

  const model = await modelForTier(alias)
  const price = await modelPrices(model)
  const rateE4 = parseRate(await getSetting("fx.usdInr"))
  // The owner's cap (harness.maxOutputTokens), never above the model's own (U9)
  const cap = await outputCap(model)
  const maxTokens = Math.min(body.max_tokens ?? cap, cap)
  const estimateUsd = upperEstimateMicroUsd(
    JSON.stringify(body.messages).length,
    maxTokens,
    price
  )
  // Without a rate or a price the cap couldn't hold: refused, not unmetered
  if (estimateUsd === null || !rateE4)
    return fail(503, "not_priced", "Kriya Harness isn't priced yet; try again later.")
  const requestKey = `harness:${randomUUID()}`
  const refused = await reserve({
    userId: device.id,
    deviceId: device.deviceId,
    requestKey,
    tier: alias,
    model,
    estimateMicroInr: applyMarkup(usdToInr(estimateUsd, rateE4), plan.markupBps),
  })
  if (refused === "cap")
    return fail(403, "cap_reached", "This month's Kriya Harness limit is reached.")
  if (refused === "plan")
    return fail(403, "plan_not_allowed", "Your plan doesn't include Kriya Harness.")
  // HD-16: three answers at once, counted in SQL with the cap
  if (refused === "open")
    return fail(
      429,
      "rate_limited",
      "Too many answers in progress; wait for one to finish.",
      {
        retryAfter: 5,
      }
    )

  const started = Date.now()
  const forward = Object.fromEntries(
    Object.entries(body).filter(([key]) => !STRIPPED.includes(key))
  )
  const send = (to: string) =>
    fetch(upstreamUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        // Attribution OpenRouter shows on its dashboards
        "http-referer": process.env.KRIYA_APP_URL || "https://kriya.ai",
        "x-title": "Kriya Harness",
      },
      body: JSON.stringify({
        ...forward,
        model: to,
        max_tokens: maxTokens,
        usage: { include: true },
      }),
      signal: request.signal,
    })

  let used = model
  let res = await send(model).catch(() => null)
  const fallback = await fallbackModel()
  if ((!res || retryable(res.status)) && fallback && fallback !== model) {
    void res?.body?.cancel().catch(() => {})
    used = fallback
    res = await send(fallback).catch(() => null)
  }
  if (!res || !res.ok) {
    const tooLong = res ? await overflowed(res) : false
    void res?.body?.cancel().catch(() => {})
    await settleFailed(requestKey, device.id)
    log.warn("harness upstream refused", {
      deviceId: device.deviceId,
      status: res?.status ?? 0,
      ...(tooLong && { overflow: true }),
    })
    if (tooLong)
      return fail(
        400,
        "context_length_exceeded",
        "The conversation is longer than the model's context window."
      )
    return !res || retryable(res.status)
      ? fail(
          502,
          "upstream_unavailable",
          "The model service is unavailable; try again shortly."
        )
      : fail(400, "bad_request", "The model service refused this request.")
  }

  const usedPrice = used === model ? price : await modelPrices(used)
  const finish = async (
    usage: UpstreamUsage | null,
    generationId: string | null,
    reason: string | null
  ) => {
    if (usage)
      await settle(requestKey, device.id, {
        model: used,
        usage,
        price: usedPrice,
        rateE4,
        markupBps: plan.markupBps,
        generationId,
        finishReason: reason,
        latencyMs: Date.now() - started,
      })
    else await settleAborted(requestKey, device.id, used)
  }

  if (!body.stream) {
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null
    // Answered but unreadable: estimated at the reservation now, not left
    // open holding a stream slot
    if (!answer || typeof answer !== "object") {
      await finish(null, null, null)
      log.warn("harness upstream answer unreadable", { deviceId: device.deviceId })
      return fail(
        502,
        "upstream_unavailable",
        "The model service is unavailable; try again shortly."
      )
    }
    const choice = (answer.choices as { finish_reason?: string }[] | undefined)?.[0]
    await finish(
      readUsage(answer),
      typeof answer.id === "string" ? answer.id : null,
      choice?.finish_reason ?? null
    )
    return Response.json(
      { ...answer, model: alias },
      { headers: { "cache-control": "no-store" } }
    )
  }
  return new Response(passThrough(res.body!, used, alias, finish), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  })
}

// The upstream SSE, line for line, with only `"model":"<id>"` rewritten to
// the alias; the usage chunk is read on the way and settles at the end, or
// when the client goes away
function passThrough(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  alias: Tier,
  finish: (
    usage: UpstreamUsage | null,
    id: string | null,
    reason: string | null
  ) => Promise<void>
) {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const named = new RegExp(
    `"model"\\s*:\\s*${JSON.stringify(model).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`,
    "g"
  )
  let pending = ""
  let usage: UpstreamUsage | null = null
  let generationId: string | null = null
  let reason: string | null = null
  let settled = false
  const done = async () => {
    if (settled) return
    settled = true
    await finish(usage, generationId, reason)
  }
  const inspect = (line: string) => {
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    try {
      const chunk = JSON.parse(payload) as {
        id?: unknown
        choices?: { finish_reason?: unknown }[]
      }
      usage = readUsage(chunk) ?? usage
      if (typeof chunk.id === "string") generationId = chunk.id
      const finished = chunk.choices?.[0]?.finish_reason
      if (typeof finished === "string") reason = finished
    } catch {}
  }
  const rewrite = (line: string) =>
    line.replace(named, `"model":${JSON.stringify(alias)}`)

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (error) {
          // Upstream broke off or the device left: settled now (estimated
          // without usage), not left open for the janitor
          await done()
          controller.error(error)
          return
        }
        const { done: ended, value } = chunk
        if (ended) {
          if (pending) {
            inspect(pending)
            controller.enqueue(encoder.encode(rewrite(pending)))
          }
          await done()
          controller.close()
          return
        }
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        if (lines.length === 0) continue
        for (const line of lines) inspect(line)
        controller.enqueue(encoder.encode(lines.map(rewrite).join("\n") + "\n"))
        return
      }
    },
    async cancel() {
      void reader.cancel().catch(() => {})
      await done()
    },
  })
}
