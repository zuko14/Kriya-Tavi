// Provider contracts for voice calls (TELEPHONY_PROVIDER_ASSESSMENT.md §4).
// Exotel (phase 5) and the mock (lib/voice/mock.ts) implement them, so the
// orchestration and dialogue code never depends on one provider. Plain
// types only: no server-only imports, so kriya-voice can load this (F7).

export type CallStatus =
  | "initiated"
  | "ringing"
  | "answered"
  | "completed"
  | "busy"
  | "no_answer"
  | "failed"
  | "canceled"
  | "unknown"

export type PlaceCallInput = {
  // Our attempt id, sent as CustomField for correlation
  attemptId: string
  // E.164, already verified and allowed
  to: string
  // A provider number from config, never from the user
  callerId: string
  // wss://…?t=<one-time token>
  streamUrl: string
  // https://…/api/voice/<provider>/status/<token>
  statusUrl: string
  ringTimeoutSeconds: number
  maxDurationSeconds: number
}

export type ProviderCall = {
  providerCallId: string
  status: CallStatus
  answeredAt: Date | null
  endedAt: Date | null
  // null = the provider didn't say
  billableSeconds: number | null
  // Integer micro-units, like every amount in Kriya (lib/money.ts)
  reportedCost: { micro: number; currency: "INR" | "USD" } | null
  // Redacted before storing
  raw: unknown
}

export type StatusEvent = {
  providerCallId: string
  // From CustomField
  attemptId: string | null
  status: CallStatus
  occurredAt: Date | null
  // The provider's event id, else callSid:status:time
  dedupeKey: string
  raw: unknown
}

export type MediaEvent =
  | {
      type: "start"
      streamId: string
      providerCallId: string
      params: Record<string, string>
    }
  | { type: "audio"; pcm: Int16Array; timestampMs: number }
  | { type: "dtmf"; digit: string }
  | { type: "mark"; name: string }
  | { type: "stop"; reason: string }

// Media WebSocket framing (Exotel: JSON + base64 16-bit PCM)
export type MediaCodec = {
  sampleRate: 8000 | 16000
  // null for messages Kriya doesn't act on, and for anything malformed
  parse(message: string): MediaEvent | null
  // One chunk, a multiple of 320 bytes (lib/voice/audio.ts chunks())
  audio(streamId: string, pcm: Int16Array): string
  mark(streamId: string, name: string): string
  clear(streamId: string): string
}

export type TelephonyProvider = {
  name: "exotel" | "plivo" | "mock"
  // Must be safe to call once per attempt; the caller guarantees that
  placeCall(input: PlaceCallInput): Promise<{ providerCallId: string }>
  // Source of truth for verification and recovery
  getCall(providerCallId: string): Promise<ProviderCall | null>
  // Recovery after a crash between "requested" and recording the provider's
  // call id: the call the provider made for this attempt (CustomField), if
  // the provider can look one up. Absent = it can't, so the attempt is unknown
  findByAttempt?(attemptId: string): Promise<ProviderCall | null>
  hangup(providerCallId: string): Promise<void>
  // Parses an untrusted webhook body into a normalized event, or null
  parseStatusEvent(body: string, headers: Headers): StatusEvent | null
  media: MediaCodec
}

export type RecognitionEvent =
  | { type: "partial"; text: string }
  | {
      type: "final"
      text: string
      confidence: number | null
      startMs: number
      endMs: number
    }
  // Barge-in signal
  | { type: "speech_started" }
  // End of utterance
  | { type: "endpoint" }
  | { type: "error"; error: Error }

export type RecognitionStream = {
  write(pcm: Int16Array): void
  events: AsyncIterable<RecognitionEvent>
  close(): Promise<{ billedSeconds: number | null }>
}

export type SpeechRecognitionProvider = {
  name: string
  // One stream per call leg
  open(opts: { language: string; sampleRate: number; hints: string[] }): RecognitionStream
}

export type SpeechSynthesisProvider = {
  name: string
  // Streams PCM at the requested rate; stops promptly when signal aborts
  synthesize(
    text: string,
    opts: { voice: string; sampleRate: number; signal: AbortSignal }
  ): AsyncIterable<Int16Array>
  // For metering: characters billed for this text
  billedUnits(text: string): number
}
