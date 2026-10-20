import type { MediaCodec, MediaEvent } from "./providers"

// Call audio is 16-bit mono PCM, little-endian ("slin"), at 8 or 16 kHz
// (VOICE_ARCHITECTURE.md §3). Exotel wants chunks of at least 3.2 KB and a
// multiple of 320 bytes; smaller ones distort, larger ones time out.

// 3,200 bytes: 100 ms at 16 kHz, 200 ms at 8 kHz
export const CHUNK_SAMPLES = 1600

export function pcmToBase64(pcm: Int16Array) {
  const bytes = Buffer.alloc(pcm.length * 2)
  pcm.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2))
  return bytes.toString("base64")
}

export function base64ToPcm(payload: string) {
  const bytes = Buffer.from(payload, "base64")
  if (bytes.length % 2) throw new Error("PCM payload has an odd number of bytes")
  return Int16Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2))
}

export const durationMs = (samples: number, sampleRate: number) =>
  (samples * 1000) / sampleRate

// Whole chunks; the last one is padded with silence
export function chunks(pcm: Int16Array) {
  const out: Int16Array[] = []
  for (let start = 0; start < pcm.length; start += CHUNK_SAMPLES) {
    const chunk = new Int16Array(CHUNK_SAMPLES)
    chunk.set(pcm.subarray(start, start + CHUNK_SAMPLES))
    out.push(chunk)
  }
  return out
}

// ponytail: linear interpolation up, pair averaging down (a crude low-pass).
// Fine for telephone speech; swap for a windowed-sinc filter if STT accuracy
// on resampled audio measures worse than on native-rate audio.
export function resample(pcm: Int16Array, from: 8000 | 16000, to: 8000 | 16000) {
  if (from === to) return pcm.slice()
  if (from === 8000) {
    return Int16Array.from({ length: pcm.length * 2 }, (_, i) => {
      const a = pcm[i >> 1]
      return i % 2 ? Math.round((a + (pcm[(i >> 1) + 1] ?? a)) / 2) : a
    })
  }
  return Int16Array.from({ length: pcm.length >> 1 }, (_, i) =>
    Math.round((pcm[2 * i] + pcm[2 * i + 1]) / 2)
  )
}

const text = (value: unknown) => (typeof value === "string" ? value : null)

// Exotel's Voicebot stream (TELEPHONY_PROVIDER_ASSESSMENT.md §2.1). The
// nesting below (start.call_sid, media.payload, mark.name …) follows the
// documented field list; confirm it against a real payload on the account
// (X9) before the first live call. The mock stream speaks the same framing.
export function exotelCodec(sampleRate: 8000 | 16000): MediaCodec {
  return {
    sampleRate,
    parse(message) {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(message)
      } catch {
        return null
      }
      if (!data || typeof data !== "object") return null
      const body = (data[String(data.event)] ?? {}) as Record<string, unknown>
      let event: MediaEvent | null = null
      switch (data.event) {
        case "start": {
          const streamId = text(body.stream_sid) ?? text(data.stream_sid)
          const callSid = text(body.call_sid)
          if (!streamId || !callSid) return null
          const raw = (body.custom_parameters ?? {}) as Record<string, unknown>
          const params = Object.fromEntries(
            Object.entries(raw).filter(([, v]) => typeof v === "string")
          ) as Record<string, string>
          event = { type: "start", streamId, providerCallId: callSid, params }
          break
        }
        case "media": {
          const payload = text(body.payload)
          if (payload === null) return null
          try {
            const timestampMs = Number(body.timestamp ?? 0)
            event = { type: "audio", pcm: base64ToPcm(payload), timestampMs }
          } catch {
            return null
          }
          break
        }
        case "dtmf": {
          const digit = text(body.digit)
          if (digit) event = { type: "dtmf", digit }
          break
        }
        case "mark": {
          const name = text(body.name)
          if (name) event = { type: "mark", name }
          break
        }
        case "stop":
          event = { type: "stop", reason: text(body.reason) ?? "stopped" }
          break
      }
      return event
    },
    audio(streamId, pcm) {
      if ((pcm.length * 2) % 320) {
        throw new Error("audio chunks must be a multiple of 320 bytes")
      }
      return JSON.stringify({
        event: "media",
        stream_sid: streamId,
        media: { payload: pcmToBase64(pcm) },
      })
    },
    mark: (streamId, name) =>
      JSON.stringify({ event: "mark", stream_sid: streamId, mark: { name } }),
    clear: (streamId) => JSON.stringify({ event: "clear", stream_sid: streamId }),
  }
}
