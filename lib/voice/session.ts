import type { LanguageModel } from "ai"
import { and, eq, sql } from "drizzle-orm"

import { privileged } from "@/db"
import {
  callAttempts,
  callOutcomes,
  callSuppressions,
  conversationTurns,
  voiceCalls,
  voiceProfiles,
  voiceUsage,
} from "@/db/schema"
import { log } from "@/lib/log"
import { usageFromMetadata } from "@/lib/models"

import { CHUNK_SAMPLES, chunks } from "./audio"
import { Dialogue, type Reply } from "./dialogue"
import { localDate } from "./languages"
import type { ModelCall } from "./outcome"
import { HANG_UP, reportCall, VerificationCall, verificationCall } from "./owner-report"
import { ACTIVE_POLICY } from "./policy/v1"
import type {
  MediaEvent,
  SpeechRecognitionProvider,
  SpeechSynthesisProvider,
} from "./providers"
import { loadAttemptContext, loadVerificationContext } from "./run-call"
import { clock, type QuietHours } from "./schedule"
import type { VoiceTaskSpec } from "./schemas"
import { transition } from "./tasks"
import { finishOutcome, settleCall } from "./verify"

// One connected call in kriya-voice (VOICE_ARCHITECTURE §2–8): the callee's
// audio goes to STT, finished utterances to the dialogue engine, its replies
// through TTS back down the stream. Turns, notes and usage are written as
// the call goes; when the stream ends the outcome is extracted and checked.
// Reads only the stream's own attempt (loadAttemptContext, T-SEC-05).

// What a session needs of voice/index.ts's Call
export type LiveCall = {
  attemptId: string
  userId: string
  events: ReadableStream<MediaEvent>
  readonly playedChunks: number
  play(pcm: Int16Array): void
  mark(name: string): void
  clear(): void
  close(code?: number): void
}

export type SessionDeps = {
  stt: SpeechRecognitionProvider
  tts: SpeechSynthesisProvider
  model: LanguageModel
  escalation?: LanguageModel | null
  voice: string
  sampleRate: 8000 | 16000
  heartbeatMs?: number
  // How long to wait for the answered webhook when the stream comes first
  connectWaitMs?: number
  // Owner calls: silence after Tavi's turn before asking again (§4)
  silenceMs?: number
}

const HEARTBEAT_MS = 5_000
// Two silences of 4 s after the greeting = the 8 s voicemail rule
// (VOICE_REMINDERS §4, §9); owner calls end by 180 s (voice.reportMaxSeconds)
const SILENCE_MS = 4_000
const OWNER_CALL_SECONDS = 180

// answered → connected. The stream can arrive before the provider's
// answered webhook, so wait for it a little. ponytail: a short poll; check
// against Exotel's real ordering (X9)
async function connect(attemptId: string, waitMs: number) {
  const until = Date.now() + waitMs
  for (;;) {
    const ok = await transition(
      privileged,
      "attempt",
      attemptId,
      "connected",
      "voice",
      {},
      {
        optional: true,
      }
    )
    if (ok) return true
    if (Date.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function runSession(call: LiveCall, deps: SessionDeps) {
  const ctx =
    (await loadAttemptContext(call.attemptId, call.userId)) ??
    (await loadVerificationContext(call.attemptId, call.userId))
  if (!ctx) {
    log.error("voice session without its attempt", { attemptId: call.attemptId })
    return call.close(1011)
  }
  if (!(await connect(call.attemptId, deps.connectWaitMs ?? 5_000))) {
    log.warn("voice stream before the call was answered", { attemptId: call.attemptId })
    return call.close(1011)
  }
  await transition(
    privileged,
    "call",
    ctx.call.id,
    "in_call",
    "voice",
    {},
    {
      optional: true,
    }
  )

  const attemptId = call.attemptId
  // A verification call has no task
  const task = "task" in ctx ? ctx.task : null
  const spec = task?.spec as VoiceTaskSpec | undefined
  const chunkMs = (CHUNK_SAMPLES * 1000) / deps.sampleRate
  const startedAt = Date.now()
  const meter = (
    values: Omit<
      typeof voiceUsage.$inferInsert,
      "userId" | "voiceTaskId" | "callAttemptId"
    >
  ) =>
    privileged
      .insert(voiceUsage)
      .values({
        userId: call.userId,
        voiceTaskId: task?.id ?? null,
        callAttemptId: attemptId,
        ...values,
      })
      .onConflictDoNothing()
      .catch((error) => log.error("voice usage record failed", { attemptId, error }))
  const llm =
    (prefix: string): ModelCall =>
    async ({ n, modelId, usage, providerMetadata }) => {
      const cost = usageFromMetadata(providerMetadata)?.costMicroUsd ?? null
      await meter({
        requestKey: `${attemptId}:${prefix}:${n}`,
        component: "llm",
        provider: "openrouter",
        product: modelId,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        usageStatus: cost === null ? "missing" : "reported",
        reportedCostMicro: cost,
        reportedCurrency: cost === null ? null : "USD",
        costSource: cost === null ? null : "provider",
      })
    }

  // The callee's dialogue: the outreach conversation, or the owner's own
  // report or verification call (VOICE_REMINDERS.md; fixed lines, no model)
  const kind = ctx.call.kind
  const dialogue =
    kind === "outreach" && task && spec
      ? new Dialogue({
          spec,
          // ponytail: one bundle exists; look up the attempt's policy_version once there are more (phase 10)
          policy: ACTIVE_POLICY,
          model: deps.model,
          escalation: deps.escalation,
          today: localDate(clock.now(), spec.timezone),
          maxCallSeconds: task.maxCallSeconds,
          onModelCall: llm("llm"),
        })
      : kind === "owner_report" && task
        ? await reportCall({ ...ctx, task }, await quietHoursOf(call.userId))
        : verificationCall(ctx)
  const outreach = dialogue instanceof Dialogue ? dialogue : null
  const maxSeconds =
    kind === "outreach" && task
      ? task.maxCallSeconds
      : Math.min(task?.maxCallSeconds ?? OWNER_CALL_SECONDS, OWNER_CALL_SECONDS)
  const stt = deps.stt.open({
    language: spec?.language ?? "en-IN",
    sampleRate: deps.sampleRate,
    hints: spec ? [spec.owner.displayName, spec.recipient.label] : [],
  })

  // Turns and notes are stored as the call goes, so a crash loses little
  let saved = 0
  let disclosurePlayed = false
  const persist = async () => {
    const fresh = dialogue.turns.slice(saved)
    saved = dialogue.turns.length
    if (fresh.length === 0) return
    await privileged
      .insert(conversationTurns)
      .values(
        fresh.map((t) => ({
          userId: call.userId,
          callAttemptId: attemptId,
          seq: t.seq,
          speaker: t.speaker,
          text: t.text,
          startMs: Date.now() - startedAt,
          sttConfidence: t.confidence === null ? null : String(t.confidence),
        }))
      )
      .onConflictDoNothing()
  }
  const live = () => ({
    observed: { disclosurePlayed, turns: dialogue.turns.map((t) => t.seq) },
    interpreted: { notes: dialogue.notes },
  })
  // The outreach call's outcome as it goes; owner calls have none
  const saveNotes = async () => {
    if (!outreach || !task) return
    await privileged
      .insert(callOutcomes)
      .values({
        userId: call.userId,
        callAttemptId: attemptId,
        voiceTaskId: task.id,
        ...live(),
      })
      .onConflictDoUpdate({
        target: callOutcomes.callAttemptId,
        set: live(),
        setWhere: sql`${callOutcomes.verifierStatus} = 'pending'`,
      })
  }
  const playedTurn = (seq: number, playedMs: number, interrupted: boolean) =>
    privileged
      .update(conversationTurns)
      .set({ playedMs: Math.round(playedMs), interrupted })
      .where(
        and(
          eq(conversationTurns.callAttemptId, attemptId),
          eq(conversationTurns.seq, seq)
        )
      )

  /* ─────────────────────────── speaking ─────────────────────────── */

  let speaking: {
    seq: number
    abort: AbortController
    from: number
    end: boolean
  } | null = null
  // Chunks handed to the call; resynced to what played after a clear
  let sent = 0
  let endReason: string | null = null
  let endedByUs = false
  const hangUp = (reason: string | null) => {
    endReason ??= reason
    endedByUs = true
    call.close(1000)
  }

  async function speak(reply: Reply) {
    await persist()
    const abort = new AbortController()
    speaking = { seq: reply.seq, abort, from: sent, end: reply.end }
    // TTS fails: the sentence once more, then the call ends (VOICE_ARCH §6)
    for (let attempt = 1; attempt <= 2; attempt++) {
      await meter({
        requestKey: `${attemptId}:tts:${reply.seq}:${attempt}`,
        component: "tts",
        provider: deps.tts.name,
        product: deps.voice,
        quantity: deps.tts.billedUnits(reply.text),
        unit: "character",
        usageStatus: "counted",
      })
      try {
        for await (const pcm of deps.tts.synthesize(reply.text, {
          voice: deps.voice,
          sampleRate: deps.sampleRate,
          signal: abort.signal,
        })) {
          if (abort.signal.aborted) return
          call.play(pcm)
          sent += chunks(pcm).length
        }
        if (!abort.signal.aborted) call.mark(`t${reply.seq}`)
        return
      } catch (error) {
        if (abort.signal.aborted) return
        log.warn("voice speech synthesis failed", { attemptId, attempt, error })
      }
    }
    dialogue.notes.flags.push("speech synthesis failed")
    hangUp("tts_failed")
  }

  // The provider played a turn to its end. An owner report is delivered
  // here (D-08), before the turn is recorded as played
  async function played(seq: number) {
    if (speaking?.seq !== seq) return
    const turn = speaking
    speaking = null
    if (seq === 0) disclosurePlayed = true
    await dialogue.played(seq, true)
    await playedTurn(seq, (sent - turn.from) * chunkMs, false)
    if (turn.end) hangUp(null)
    else listenForSilence()
  }

  // Barge-in (T-DLG-05): the callee talks over Tavi. Drop what hasn't
  // played, stop synthesis, and record how much of the turn was heard
  async function bargeIn() {
    if (!speaking) return
    const turn = speaking
    speaking = null
    turn.abort.abort()
    call.clear()
    const heard = Math.max(0, call.playedChunks - turn.from)
    sent = call.playedChunks
    await dialogue.played(turn.seq, false)
    await playedTurn(turn.seq, heard * chunkMs, true)
  }

  // Owner calls: nothing said for a while after Tavi's turn (the voicemail
  // rule, VOICE_REMINDERS §4). Any speech or key press stops the wait
  let hush: NodeJS.Timeout | undefined
  function listenForSilence() {
    clearTimeout(hush)
    if (outreach) return
    const owner = dialogue as Exclude<typeof dialogue, Dialogue>
    hush = setTimeout(() => {
      queue = queue.then(async () => {
        const reply = owner.silence()
        if (reply === HANG_UP) hangUp(owner.endReason)
        else if (reply) await speak(reply)
      })
    }, deps.silenceMs ?? SILENCE_MS)
  }

  /* ─────────────────────────── listening ────────────────────────── */

  let heard: string[] = []
  let confidence: number | null = null
  let silence: NodeJS.Timeout | undefined
  let queue = Promise.resolve()
  const respond = () => {
    clearTimeout(silence)
    if (heard.length === 0) return
    const text = heard.join(" ")
    const conf = confidence
    heard = []
    confidence = null
    queue = queue
      .then(async () => {
        const reply = await dialogue.hear(text, conf)
        await persist()
        await saveNotes()
        if (reply) await speak(reply)
      })
      .catch((error) => {
        log.error("voice turn failed", { attemptId, error })
        hangUp("tavi_hangup")
      })
  }

  const listening = (async () => {
    for await (const event of stt.events) {
      if (event.type === "partial" && event.text.trim()) {
        clearTimeout(hush)
        // ponytail: barge-in on the first recognised words, not raw speech
        // energy; a cough makes no words. Tune with recordings (L2)
        await bargeIn()
      } else if (event.type === "final" && event.text.trim()) {
        clearTimeout(hush)
        heard.push(event.text)
        if (event.confidence !== null) {
          confidence = Math.min(confidence ?? 1, event.confidence)
        }
        clearTimeout(silence)
        silence = setTimeout(respond, ACTIVE_POLICY.thresholds.endpointSilenceMs)
      } else if (event.type === "endpoint") {
        respond()
      } else if (event.type === "error") {
        log.warn("voice speech recognition failed", { attemptId, error: event.error })
        dialogue.notes.flags.push("speech recognition failed")
        hangUp("stt_failed")
      }
    }
  })().catch((error) => log.error("voice listening failed", { attemptId, error }))

  // Tells recovery this call is alive; the owner's cancel ends it here,
  // since no worker holds a connected call
  const heartbeat = setInterval(async () => {
    try {
      await privileged
        .update(callAttempts)
        .set({ streamHeartbeatAt: sql`now()` })
        .where(eq(callAttempts.id, attemptId))
      const [row] = await privileged
        .select({ cancel: voiceCalls.cancelRequestedAt })
        .from(voiceCalls)
        .where(eq(voiceCalls.id, ctx.call.id))
      if (row?.cancel) hangUp("owner_cancel")
    } catch (error) {
      log.warn("voice heartbeat failed", { attemptId, error })
    }
  }, deps.heartbeatMs ?? HEARTBEAT_MS)
  const limit = setTimeout(() => hangUp("max_duration"), maxSeconds * 1000)

  await saveNotes()
  queue = queue.then(() => speak(dialogue.opening()))

  const reader = call.events.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.type === "audio") stt.write(value.pcm)
    else if (value.type === "mark" && /^t\d+$/.test(value.name)) {
      await played(Number(value.name.slice(1)))
    } else if (value.type === "dtmf" && dialogue instanceof VerificationCall) {
      // The keyed digits go to the code check only; never stored or logged
      clearTimeout(hush)
      const digit = value.digit
      queue = queue.then(async () => {
        const reply = await dialogue.key(digit)
        await persist()
        if (reply) await speak(reply)
      })
    } else if (value.type === "stop") endReason ??= "callee_hangup"
  }

  /* ─────────────────────────── the end ──────────────────────────── */

  clearInterval(heartbeat)
  clearTimeout(limit)
  clearTimeout(silence)
  clearTimeout(hush)
  const last = speaking as { abort: AbortController } | null
  last?.abort.abort()
  const billed = await stt.close().catch(() => ({ billedSeconds: null }))
  await listening
  await queue
  await meter({
    requestKey: `${attemptId}:stt:1`,
    component: "stt",
    provider: deps.stt.name,
    product: spec?.language ?? "en-IN",
    quantity: billed.billedSeconds === null ? null : Math.ceil(billed.billedSeconds),
    unit: "second",
    usageStatus: billed.billedSeconds === null ? "missing" : "reported",
  })
  await persist()
  await saveNotes()
  await transition(
    privileged,
    "attempt",
    attemptId,
    "ended",
    "voice",
    {},
    {
      optional: true,
    }
  )
  // An owner call says why it hung up (not_owner, voicemail)
  if (!outreach)
    endReason = (dialogue as { endReason: string | null }).endReason ?? endReason
  const reason = endReason ?? (endedByUs ? "tavi_hangup" : "callee_hangup")
  await privileged
    .update(callAttempts)
    .set({ endReason: sql`coalesce(${callAttempts.endReason}, ${reason})` })
    .where(eq(callAttempts.id, attemptId))
  // "Don't call me again" (CONVERSATION §8): no one calls this number again
  if (outreach?.notes.optOut && task) {
    await privileged
      .insert(callSuppressions)
      .values({
        phoneHash: task.recipientPhoneHash,
        reason: "recipient_opt_out",
        sourceAttemptId: attemptId,
      })
      .onConflictDoNothing()
  }
  log.info("voice session ended", { attemptId, turns: dialogue.turns.length })
  // An owner call settles from its delivery, not an outcome
  if (!outreach) return settleCall(ctx.call.id)
  await finishOutcome(attemptId, {
    model: deps.model,
    escalation: deps.escalation,
    onModelCall: llm("extract"),
  })
}

// The owner's quiet hours, for "remind me again at …"
async function quietHoursOf(userId: string): Promise<QuietHours> {
  const [profile] = await privileged
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, userId))
  return profile ?? { timezone: "Asia/Kolkata", quietStart: "21:30", quietEnd: "08:00" }
}
