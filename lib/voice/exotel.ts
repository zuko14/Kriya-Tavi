import { exotelCodec } from "./audio"
import type {
  CallStatus,
  ProviderCall,
  StatusEvent,
  TelephonyProvider,
} from "./providers"

// Exotel (TELEPHONY_PROVIDER_ASSESSMENT.md §2): "connect number to call
// flow" rings the callee and runs an App Bazaar flow whose Voicebot applet
// opens the media stream (lib/voice/audio.ts exotelCodec). Docs read
// 2026-10-20: developer.exotel.com voice-v1 connect-to-flow, call-details,
// references/webhooks. Unverified on the account, so handled defensively:
// - callback content type (JSON or form): both are parsed (X5)
// - timestamps "YYYY-MM-DD HH:mm:ss" carry no zone: read as IST (X1)
// - Price has no currency: kept in raw, never reported as cost (X8)
// - no hangup API is documented: TimeLimit is the hard cap
// - how the stream token reaches the Voicebot applet (X2)
// Plain Node: no server-only imports (F7).

export type ExotelConfig = {
  accountSid: string
  apiKey: string
  apiToken: string
  // api.exotel.com (Singapore) or api.in.exotel.com (Mumbai)
  host: string
  // http://my.exotel.com/<sid>/exoml/start_voice/<app_id>
  flowUrl: string
  fetch?: typeof fetch
}

// From the environment; null when any part is missing
export function exotelConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ExotelConfig | null {
  const config = {
    accountSid: env.EXOTEL_ACCOUNT_SID?.trim() ?? "",
    apiKey: env.EXOTEL_API_KEY?.trim() ?? "",
    apiToken: env.EXOTEL_API_TOKEN?.trim() ?? "",
    host: env.EXOTEL_SUBDOMAIN?.trim() ?? "",
    flowUrl: env.EXOTEL_FLOW_URL?.trim() ?? "",
  }
  return Object.values(config).every(Boolean) ? config : null
}

const STATUS: Record<string, CallStatus> = {
  queued: "initiated",
  ringing: "ringing",
  "in-progress": "answered",
  answered: "answered",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
}

export const exotelStatus = (value: unknown): CallStatus =>
  STATUS[String(value ?? "").toLowerCase()] ?? "unknown"

export function exotelTime(value: unknown): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(String(value ?? ""))
  return match ? new Date(`${match[1]}T${match[2]}+05:30`) : null
}

const seconds = (value: unknown) => {
  const n = Number(value)
  return value !== null && value !== "" && Number.isFinite(n) && n >= 0
    ? Math.round(n)
    : null
}

// A JSON body, or a form one (urlencoded); Legs only survive as JSON
function parseBody(body: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(body)
    return data && typeof data === "object" && !Array.isArray(data) ? data : null
  } catch {
    const form = Object.fromEntries(new URLSearchParams(body))
    return Object.keys(form).length ? form : null
  }
}

export function exotelTelephony(config: ExotelConfig): TelephonyProvider {
  const http = config.fetch ?? fetch
  const base = `https://${config.host}/v1/Accounts/${encodeURIComponent(config.accountSid)}`
  const auth = `Basic ${Buffer.from(`${config.apiKey}:${config.apiToken}`).toString("base64")}`

  // Errors carry the HTTP status so run-call.ts can tell "refused" (4xx,
  // no call made) from "may have reached it", and Exotel's reason with any
  // number cut to its last 4 digits (it can echo phone numbers)
  async function request(path: string, init: RequestInit = {}) {
    const response = await http(`${base}${path}`, {
      ...init,
      headers: { authorization: auth, accept: "application/json", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      let reason = body
      try {
        const data = JSON.parse(body)
        reason = data?.RestException?.Message ?? data?.Message ?? body
      } catch {}
      reason = String(reason)
        .replace(/\+?\d{5,}/g, (n) => `***${n.slice(-4)}`)
        .slice(0, 200)
      throw Object.assign(
        new Error(`Exotel answered ${response.status}${reason ? `: ${reason}` : ""}`),
        { status: response.status }
      )
    }
    return (await response.json()) as { Call?: Record<string, unknown> }
  }

  return {
    name: "exotel",
    media: exotelCodec(8000),

    async placeCall(input) {
      const form = new URLSearchParams({
        From: input.to,
        CallerId: input.callerId,
        Url: config.flowUrl,
        CallType: "trans",
        CustomField: input.attemptId,
        TimeOut: String(input.ringTimeoutSeconds),
        TimeLimit: String(input.maxDurationSeconds),
      })
      if (input.statusUrl) {
        form.set("StatusCallback", input.statusUrl)
        form.set("StatusCallbackContentType", "application/json")
        form.append("StatusCallbackEvents[0]", "terminal")
        form.append("StatusCallbackEvents[1]", "answered")
      }
      const data = await request("/Calls/connect.json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      })
      const sid = data.Call?.Sid
      // 2xx without a call id: it may have dialled, so not a 4xx
      if (typeof sid !== "string" || !sid) throw new Error("Exotel returned no call id")
      return { providerCallId: sid }
    },

    async getCall(providerCallId): Promise<ProviderCall | null> {
      let data
      try {
        data = await request(
          `/Calls/${encodeURIComponent(providerCallId)}.json?details=true`
        )
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null
        throw error
      }
      const call = data.Call
      if (!call || call.Sid !== providerCallId) return null
      const details = (call.Details ?? {}) as Record<string, unknown>
      const talked = seconds(details.ConversationDuration)
      return {
        providerCallId,
        status: exotelStatus(call.Status),
        // No answer time is reported; a call that talked was answered at the start
        answeredAt: talked ? exotelTime(call.StartTime) : null,
        endedAt: exotelTime(call.EndTime),
        // Duration and Price update about two minutes after the call ends
        billableSeconds: seconds(call.Duration),
        reportedCost: null,
        raw: data,
      }
    },

    // Exotel documents no way to end a call through the API (checked
    // 2026-10-20); TimeLimit ends it. Callers log this and go on
    async hangup() {
      throw new Error("Exotel has no hangup API; the call ends at TimeLimit")
    },

    parseStatusEvent(body): StatusEvent | null {
      const data = parseBody(body)
      if (!data || typeof data.CallSid !== "string" || !data.CallSid) return null
      // An "answered" event may still carry Status in-progress
      const status =
        data.EventType === "answered" ? "answered" : exotelStatus(data.Status)
      const at = data.DateUpdated ?? data.EndTime ?? data.StartTime
      return {
        providerCallId: data.CallSid,
        attemptId:
          typeof data.CustomField === "string" && data.CustomField
            ? data.CustomField
            : null,
        status,
        occurredAt: exotelTime(at),
        dedupeKey: `${data.CallSid}:${data.EventType ?? ""}:${data.Status ?? ""}:${at ?? ""}`,
        raw: data,
      }
    },
  }
}
