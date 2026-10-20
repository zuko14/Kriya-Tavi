import { describe, expect, it } from "vitest"

import {
  base64ToPcm,
  CHUNK_SAMPLES,
  chunks,
  durationMs,
  exotelCodec,
  pcmToBase64,
  resample,
} from "@/lib/voice/audio"

const sine = (hz: number, rate: number, samples: number) =>
  Int16Array.from({ length: samples }, (_, i) =>
    Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate))
  )

describe("PCM framing", () => {
  it("encodes 16-bit little-endian PCM to base64 and back", () => {
    expect(pcmToBase64(Int16Array.from([1, -2]))).toBe("AQD+/w==")
    const pcm = sine(440, 8000, 321)
    expect(base64ToPcm(pcmToBase64(pcm))).toEqual(pcm)
    expect(() => base64ToPcm("AQD+")).toThrow(/odd/)
  })

  it("cuts audio into 3,200-byte chunks, padding the last with silence", () => {
    expect(CHUNK_SAMPLES * 2).toBe(3200)
    const parts = chunks(sine(300, 16000, 4000))
    expect(parts.map((p) => p.length)).toEqual([1600, 1600, 1600])
    expect(parts.every((p) => (p.length * 2) % 320 === 0)).toBe(true)
    expect([...parts[2].subarray(800)].every((s) => s === 0)).toBe(true)
    expect(chunks(new Int16Array(0))).toEqual([])
  })

  it("knows how long a chunk plays at each rate", () => {
    expect(durationMs(CHUNK_SAMPLES, 16000)).toBe(100)
    expect(durationMs(CHUNK_SAMPLES, 8000)).toBe(200)
  })

  it("resamples between 8 and 16 kHz", () => {
    const narrow = sine(500, 8000, 800)
    const wide = resample(narrow, 8000, 16000)
    expect(wide.length).toBe(1600)
    for (let i = 0; i < narrow.length; i++) expect(wide[2 * i]).toBe(narrow[i])
    const back = resample(wide, 16000, 8000)
    expect(back.length).toBe(800)
    const error = Math.max(...back.map((s, i) => Math.abs(s - narrow[i])))
    expect(error).toBeLessThan(1200)
    const same = resample(narrow, 8000, 8000)
    expect(same).toEqual(narrow)
    expect(same).not.toBe(narrow)
  })
})

describe("Exotel stream framing", () => {
  const codec = exotelCodec(8000)

  it("parses start, media, dtmf, mark and stop", () => {
    expect(
      codec.parse(
        JSON.stringify({
          event: "start",
          stream_sid: "S1",
          start: {
            stream_sid: "S1",
            call_sid: "CA1",
            custom_parameters: { t: "token" },
            media_format: { encoding: "raw/slin", sample_rate: "8000" },
          },
        })
      )
    ).toEqual({
      type: "start",
      streamId: "S1",
      providerCallId: "CA1",
      params: { t: "token" },
    })
    const pcm = sine(300, 8000, 160)
    expect(
      codec.parse(
        JSON.stringify({
          event: "media",
          stream_sid: "S1",
          media: { chunk: 2, timestamp: "200", payload: pcmToBase64(pcm) },
        })
      )
    ).toEqual({ type: "audio", pcm, timestampMs: 200 })
    expect(codec.parse(JSON.stringify({ event: "dtmf", dtmf: { digit: "5" } }))).toEqual({
      type: "dtmf",
      digit: "5",
    })
    expect(codec.parse(JSON.stringify({ event: "mark", mark: { name: "s1" } }))).toEqual({
      type: "mark",
      name: "s1",
    })
    expect(
      codec.parse(JSON.stringify({ event: "stop", stop: { reason: "callended" } }))
    ).toEqual({ type: "stop", reason: "callended" })
  })

  it("ignores connected, unknown and malformed messages", () => {
    for (const message of [
      JSON.stringify({ event: "connected" }),
      JSON.stringify({ event: "weather" }),
      JSON.stringify({ event: "start", start: { call_sid: "CA1" } }),
      JSON.stringify({ event: "media", media: { payload: 42 } }),
      JSON.stringify({ event: "media", media: { payload: "AQD+" } }),
      "not json",
      "null",
    ]) {
      expect(codec.parse(message)).toBeNull()
    }
  })

  it("writes media, mark and clear for one stream", () => {
    const pcm = chunks(sine(300, 8000, 1600))[0]
    expect(JSON.parse(codec.audio("S1", pcm))).toEqual({
      event: "media",
      stream_sid: "S1",
      media: { payload: pcmToBase64(pcm) },
    })
    expect(JSON.parse(codec.mark("S1", "s1"))).toEqual({
      event: "mark",
      stream_sid: "S1",
      mark: { name: "s1" },
    })
    expect(JSON.parse(codec.clear("S1"))).toEqual({ event: "clear", stream_sid: "S1" })
  })

  it("refuses audio that isn't a multiple of 320 bytes", () => {
    expect(() => codec.audio("S1", new Int16Array(100))).toThrow(/320/)
  })
})
