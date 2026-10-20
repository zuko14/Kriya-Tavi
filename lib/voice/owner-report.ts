import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto"

import { and, count, eq, gt, gte, inArray, isNull, max, ne, sql } from "drizzle-orm"

import { privileged, withUser } from "@/db"
import {
  callAttempts,
  phoneVerifications,
  voiceCalls,
  voiceProfiles,
  voiceTasks,
} from "@/db/schema"
import { log } from "@/lib/log"

import type { Reply, Turn } from "./dialogue"
import { languageFor, localDate } from "./languages"
import type { Interpreted } from "./outcome"
import { loadReportContext, VERIFICATION_MINUTES, VERIFICATION_TRIES } from "./run-call"
import {
  clock,
  fromLocal,
  inQuietHours,
  reportWindowEnd,
  type QuietHours,
} from "./schedule"
import { parseIndianMobile, type VoiceTaskSpec } from "./schemas"
import {
  createDraft,
  fail,
  phoneHash,
  suppressed,
  transition,
  voiceAvailable,
} from "./tasks"

// The owner's own calls (VOICE_REMINDERS.md, D-07, D-08, D-13): the report
// call and the number-verification call. Fixed lines and fixed patterns,
// no model. Each is a dialogue with Dialogue's shape (opening, hear,
// played), so lib/voice/session.ts runs it the same way; what they change
// goes through the effects, bound to this call, its attempt and its owner.

// Hang up without another word (voicemail: no details are left)
export const HANG_UP = "hang_up" as const

/* ─────────────────────────── the report call ───────────────────────── */

export type ReportFacts = {
  label: string
  first: string
  report: string
  // Times the callee or Tavi mentioned, spoken ("Wednesday the 14th at 3 PM")
  times: string[]
  timezone: string
  quiet: QuietHours
  language: string
}

export type ReportEffects = {
  delivered(): Promise<void>
  acknowledged(): Promise<void>
  cancelOthers(turnSeq: number): Promise<number>
  remindAt(at: Date, turnSeq: number): Promise<void>
  draftFollowUp(turnSeq: number): Promise<void>
}

type Pending = { kind: "cancel" } | { kind: "when" } | { kind: "remind"; at: Date }

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

export class ReportCall {
  readonly turns: Turn[] = []
  readonly notes = { flags: [] as string[] }
  endReason: string | null = null
  private state: "identity" | "commands" | "done" = "identity"
  private asked = 0
  private reportSeq = -1
  private pending: Pending | null = null
  private acked = false
  private readonly lang

  constructor(
    private readonly facts: ReportFacts,
    private readonly effects: ReportEffects
  ) {
    this.lang = languageFor(facts.language)
  }

  private say(text: string, end = false): Reply {
    const seq = this.turns.length
    this.turns.push({ seq, speaker: "tavi", text, confidence: null })
    if (end) this.state = "done"
    return { seq, text, end }
  }

  private get o() {
    return this.lang.owner
  }

  opening(): Reply {
    this.asked = 1
    return this.say(this.o.greeting(this.facts.label, this.facts.first))
  }

  // D-08: the report's last mark, while the call is connected
  async played(seq: number, complete: boolean) {
    if (complete && seq === this.reportSeq) await this.effects.delivered()
  }

  // Silence in the identity check: ask once more, then treat it as
  // voicemail (§4). After the report the owner may simply listen
  silence(): Reply | typeof HANG_UP | null {
    if (this.state !== "identity") return null
    if (this.asked === 1) {
      this.asked = 2
      return this.say(this.o.askAgain(this.facts.first))
    }
    this.endReason = "voicemail"
    this.state = "done"
    return HANG_UP
  }

  private reportTurn() {
    const reply = this.say(`${this.facts.report} ${this.o.offer}`)
    this.reportSeq = reply.seq
    return reply
  }

  async hear(text: string, confidence: number | null = null): Promise<Reply | null> {
    const seq = this.turns.length
    this.turns.push({ seq, speaker: "callee", text, confidence })
    if (this.state === "done") return null
    const is = this.o.is

    if (this.state === "identity") {
      // A clear no ends the call without a word about the task (S30)
      if (is.no(text) && !this.lang.is.affirmative(text)) {
        this.endReason = "not_owner"
        return this.say(this.o.wrongPerson, true)
      }
      this.state = "commands"
      return this.reportTurn()
    }

    const pending = this.pending
    this.pending = null
    if (pending?.kind === "when") return this.remind(text)
    if (pending) {
      if (!this.lang.is.affirmative(text)) return this.say(this.o.unchanged)
      if (pending.kind === "cancel") {
        const n = await this.effects.cancelOthers(seq)
        return this.say(n ? this.o.cancelled : this.o.nothingToCancel)
      }
      await this.effects.remindAt(pending.at, seq)
      return this.say(this.o.reminded)
    }

    if (is.cancel(text)) {
      this.pending = { kind: "cancel" }
      return this.say(this.o.confirmCancel(this.facts.label))
    }
    if (is.remind(text)) return this.remind(text)
    if (is.callAgain(text)) {
      await this.effects.draftFollowUp(seq)
      return this.say(this.o.draftMade(this.facts.label))
    }
    if (is.times(text)) return this.say(this.o.times(this.facts.times))
    if (is.repeat(text)) return this.reportTurn()
    if (is.done(text)) {
      if (!this.acked) {
        this.acked = true
        await this.effects.acknowledged()
      }
      return this.say(this.o.goodbye, true)
    }
    return this.say(this.o.cantDo)
  }

  // "Remind me again at 8": the next time it can mean, never in quiet hours
  private remind(text: string): Reply {
    const { timezone, quiet } = this.facts
    const now = clock.now()
    const today = localDate(now, timezone)
    const said = this.lang.normalize(text, today)
    if (!said.time) {
      this.pending = { kind: "when" }
      return this.say(this.o.askWhen)
    }
    // "8" without AM/PM is whichever of 8 and 20 comes next
    const [h, m] = said.time.split(":").map(Number)
    const times =
      said.ask === "meridiem"
        ? [
            said.time,
            `${String((h + 12) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
          ]
        : [said.time]
    const dates = said.date ? [said.date] : [today, addDays(today, 1)]
    const next = dates
      .flatMap((date) =>
        times.map((time) => ({ date, time, at: fromLocal(date, time, timezone) }))
      )
      .filter((c) => c.at > now)
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0]
    if (!next) return this.say(this.o.cantDo)
    if (inQuietHours(next.at, quiet)) return this.say(this.o.quietHours)
    this.pending = { kind: "remind", at: next.at }
    return this.say(this.o.confirmRemind(this.lang.speak(next.date, next.time)))
  }
}

// The report, from what's true at dial time (§5): the verified outcome if
// the call connected, else when it was tried, else that it hasn't been
export function reportText(
  label: string,
  timezone: string,
  context: Awaited<ReturnType<typeof loadReportContext>>,
  language = "en-IN"
) {
  const r = languageFor(language).owner.report
  const speak = languageFor(language).speak
  const { attempts, outcome } = context
  const interpreted = outcome?.interpreted as Partial<Interpreted> | null | undefined
  const proposed = (interpreted?.proposed_times ?? []).map((t) => speak(t.date, t.time))
  const times = [...new Set(proposed)]

  if (outcome && outcome.status !== "accepted") return { text: r.review(label), times }
  if (outcome && interpreted) {
    const agreed = interpreted.agreed_times?.find((a) => !a.superseded)
    const byCallee = (interpreted.proposed_times ?? [])
      .filter((t) => t.by === "callee")
      .map((t) => speak(t.date, t.time))
    let text =
      interpreted.result === "agreed" && agreed
        ? r.agreed(label, speak(agreed.date, agreed.time))
        : interpreted.result === "alternative_proposed" && byCallee.length
          ? r.alternative(label, byCallee)
          : interpreted.result === "declined"
            ? r.declined(label)
            : interpreted.result === "wrong_person"
              ? r.wrongPerson
              : r.unclear(label)
    const asked = (interpreted.unresolved_questions ?? [])
      .map((q) => q.question)
      .slice(0, 2)
    if (asked.length) text += ` ${r.questions(asked)}`
    return { text, times }
  }
  const tried = attempts.filter((a) => a.requestedAt)
  if (tried.length === 0) return { text: r.notYet(label), times }
  const clockAt = (at: Date) =>
    languageFor(language).clock(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(at)
    )
  const last = tried.at(-1)!.status
  return {
    text: r.notReached(
      label,
      tried.map((a) => clockAt(a.requestedAt!)),
      last === "busy" ? "busy" : last === "no_answer" ? "no_answer" : "failed"
    ),
    times,
  }
}

// The report call for this attempt, its facts read at dial time and its
// effects bound to this call, attempt and owner
export async function reportCall(
  ctx: {
    attempt: { id: string; userId: string }
    call: { id: string; voiceTaskId: string | null }
    task: typeof voiceTasks.$inferSelect
  },
  quiet: QuietHours
) {
  const { attempt, call, task } = ctx
  const userId = attempt.userId
  const spec = task.spec as VoiceTaskSpec
  const { text, times } = reportText(
    task.recipientLabel,
    spec.timezone,
    await loadReportContext(task.id, userId),
    spec.language
  )
  const evidence = (turnSeq: number) => ({ attemptId: attempt.id, turnSeq })

  const effects: ReportEffects = {
    async delivered() {
      const at = new Date()
      await privileged
        .update(voiceCalls)
        .set({ deliveredAt: at })
        .where(
          and(
            eq(voiceCalls.id, call.id),
            eq(voiceCalls.userId, userId),
            isNull(voiceCalls.deliveredAt)
          )
        )
      await privileged
        .update(callAttempts)
        .set({ lastReportMarkAt: at })
        .where(and(eq(callAttempts.id, attempt.id), eq(callAttempts.userId, userId)))
      log.info("voice report delivered", { attemptId: attempt.id })
    },
    async acknowledged() {
      await privileged
        .update(voiceCalls)
        .set({ acknowledgedAt: new Date() })
        .where(and(eq(voiceCalls.id, call.id), eq(voiceCalls.userId, userId)))
    },
    async cancelOthers(turnSeq) {
      return privileged.transaction(async (tx) => {
        // voice_transition() cancels only a call whose cancel was requested
        const others = await tx
          .update(voiceCalls)
          .set({ cancelRequestedAt: new Date() })
          .where(
            and(
              eq(voiceCalls.voiceTaskId, task.id),
              eq(voiceCalls.userId, userId),
              eq(voiceCalls.kind, "owner_report"),
              ne(voiceCalls.id, call.id),
              inArray(voiceCalls.status, ["scheduled", "retry_wait"])
            )
          )
          .returning({ id: voiceCalls.id })
        for (const other of others) {
          await transition(tx, "call", other.id, "canceled", "owner", evidence(turnSeq))
        }
        return others.length
      })
    },
    async remindAt(at, turnSeq) {
      await privileged.transaction(async (tx) => {
        const [profile] = await tx
          .select()
          .from(voiceProfiles)
          .where(eq(voiceProfiles.userId, userId))
        if (!profile?.ownerPhoneE164 || !profile.ownerPhoneVerifiedAt) return
        const [last] = await tx
          .select({ seq: max(voiceCalls.seq) })
          .from(voiceCalls)
          .where(
            and(eq(voiceCalls.voiceTaskId, task.id), eq(voiceCalls.kind, "owner_report"))
          )
        await tx
          .insert(voiceCalls)
          .values({
            userId,
            voiceTaskId: task.id,
            kind: "owner_report",
            seq: (last?.seq ?? 0) + 1,
            toPhoneE164: profile.ownerPhoneE164,
            notBefore: at,
            availableAt: at,
            windowEnd: reportWindowEnd(at, profile),
            maxAttempts: profile.reportMaxAttempts,
          })
          .onConflictDoNothing()
      })
      log.info("voice report call added by voice", { attemptId: attempt.id, turnSeq })
    },
    // A draft only (D-09): nobody is called until the owner confirms it
    async draftFollowUp(turnSeq) {
      const made = await createDraft(userId, {
        idempotencyKey: `follow-up:${attempt.id}:${turnSeq}`,
        recipientLabel: task.recipientLabel,
        recipientName: task.recipientName ?? undefined,
        recipientPhone: task.recipientPhoneE164,
        purpose: task.purpose,
        goal: spec.goal,
        authority: spec.authority,
        mustNot: spec.mustNot,
      })
      if (!made.ok) log.warn("voice follow-up draft refused", { attemptId: attempt.id })
    },
  }
  return new ReportCall(
    {
      label: task.recipientLabel,
      first: spec.owner.displayName.split(" ")[0] ?? spec.owner.displayName,
      report: text,
      times,
      timezone: spec.timezone,
      quiet,
      language: spec.language,
    },
    effects
  )
}

/* ─────────────────────── the verification call ─────────────────────── */

const CODE_LENGTH = 6

const codeHash = (verificationId: string, code: string) => {
  const key = process.env.KRIYA_PHONE_HASH_KEY?.trim()
  return key
    ? createHmac("sha256", key).update(`${verificationId}:${code}`).digest("hex")
    : null
}

export type CodeCheck = "ok" | "wrong" | "closed"

export class VerificationCall {
  readonly turns: Turn[] = []
  readonly notes = { flags: [] as string[] }
  endReason: string | null = null
  private digits = ""
  private finished = false
  private readonly v

  constructor(
    private readonly check: (code: string) => Promise<CodeCheck>,
    language = "en-IN"
  ) {
    this.v = languageFor(language).owner.verify
  }

  private say(text: string, end = false): Reply {
    const seq = this.turns.length
    this.turns.push({ seq, speaker: "tavi", text, confidence: null })
    if (end) this.finished = true
    return { seq, text, end }
  }

  opening = () => this.say(this.v.ask)
  played() {}
  silence = () => null

  async hear(text: string, confidence: number | null = null) {
    this.turns.push({ seq: this.turns.length, speaker: "callee", text, confidence })
    return this.finished ? null : this.say(this.v.keypad)
  }

  // Digits are never stored or logged; only the code's check is
  async key(digit: string): Promise<Reply | null> {
    if (this.finished) return null
    if (!/^\d$/.test(digit)) {
      this.digits = ""
      return null
    }
    this.digits += digit
    if (this.digits.length < CODE_LENGTH) return null
    const code = this.digits
    this.digits = ""
    const result = await this.check(code)
    if (result === "ok") return this.say(this.v.done, true)
    if (result === "wrong") return this.say(this.v.again)
    this.endReason = "verification_failed"
    return this.say(this.v.failed, true)
  }
}

// Checks a keyed code against this call's verification: right → the
// number is the owner's, verified now; wrong → one try fewer; three wrong,
// expired or used → closed
export function verificationCall(ctx: {
  attempt: { userId: string }
  call: { id: string }
}) {
  const userId = ctx.attempt.userId
  return new VerificationCall((code) =>
    privileged.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(phoneVerifications)
        .where(
          and(
            eq(phoneVerifications.voiceCallId, ctx.call.id),
            eq(phoneVerifications.userId, userId)
          )
        )
        .for("update")
      const now = clock.now()
      if (
        !row ||
        row.verifiedAt ||
        row.expiresAt <= now ||
        row.tries >= VERIFICATION_TRIES
      ) {
        return "closed"
      }
      const expected = Buffer.from(row.codeHash, "hex")
      const got = Buffer.from(codeHash(row.id, code) ?? "", "hex")
      if (expected.length === got.length && timingSafeEqual(expected, got)) {
        await tx
          .update(phoneVerifications)
          .set({ verifiedAt: now })
          .where(eq(phoneVerifications.id, row.id))
        await tx
          .insert(voiceProfiles)
          .values({ userId, ownerPhoneE164: row.phoneE164, ownerPhoneVerifiedAt: now })
          .onConflictDoUpdate({
            target: voiceProfiles.userId,
            set: { ownerPhoneE164: row.phoneE164, ownerPhoneVerifiedAt: now },
          })
        log.info("voice owner number verified", { verificationId: row.id })
        return "ok"
      }
      const tries = row.tries + 1
      await tx
        .update(phoneVerifications)
        .set({ tries })
        .where(eq(phoneVerifications.id, row.id))
      return tries >= VERIFICATION_TRIES ? "closed" : "wrong"
    })
  )
}

// Verification calls a number may get in 24 hours, from every account
// together: the number typed in may be someone else's (F33)
const VERIFICATIONS_PER_NUMBER_DAY = 3

// The owner asks to verify a number (API §"Preferences and verification"):
// a code to show on screen, and a verification call due now. Older codes
// stop working. Per-account rate limits are the action's (actions/voice.ts);
// suppression and the per-number cap are here
export async function startPhoneVerification(userId: string, phoneInput: string) {
  if (!(await voiceAvailable(userId))) {
    return fail("voice_unavailable", "Phone calls aren't available on your account.")
  }
  const phone = parseIndianMobile(phoneInput)
  if (!phone) {
    return fail("invalid", "Enter an Indian mobile number.", {
      phone: "Enter a 10-digit Indian mobile number.",
    })
  }
  const id = randomUUID()
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0")
  const hash = codeHash(id, code)
  const numberHash = phoneHash(phone)
  if (!hash || !numberHash) {
    log.warn("voice verification refused: KRIYA_PHONE_HASH_KEY is not set")
    return fail("voice_unavailable", "Phone calls aren't available on your account.")
  }
  const now = clock.now()
  const expiresAt = new Date(now.getTime() + VERIFICATION_MINUTES * 60_000)
  const refused = await privileged.transaction(async (tx) => {
    if (await suppressed(tx, numberHash)) {
      return fail("suppressed", "This number can't be called.")
    }
    // One count per number at a time, so two accounts can't both pass it
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${numberHash}))`)
    const [recent] = await tx
      .select({ n: count() })
      .from(phoneVerifications)
      .where(
        and(
          eq(phoneVerifications.phoneE164, phone),
          gte(phoneVerifications.createdAt, sql`now() - interval '1 day'`)
        )
      )
    if ((recent?.n ?? 0) >= VERIFICATIONS_PER_NUMBER_DAY) {
      return fail(
        "limit_number",
        "This number has had several verification calls today. Try tomorrow."
      )
    }
    await tx
      .update(phoneVerifications)
      .set({ expiresAt: now })
      .where(
        and(
          eq(phoneVerifications.userId, userId),
          isNull(phoneVerifications.verifiedAt),
          gt(phoneVerifications.expiresAt, now)
        )
      )
    const [call] = await tx
      .insert(voiceCalls)
      .values({
        userId,
        voiceTaskId: null,
        kind: "verification",
        seq: 1,
        toPhoneE164: phone,
        notBefore: now,
        availableAt: now,
        maxAttempts: 1,
      })
      .returning({ id: voiceCalls.id })
    await tx.insert(phoneVerifications).values({
      id,
      userId,
      phoneE164: phone,
      codeHash: hash,
      expiresAt,
      voiceCallId: call.id,
    })
    return null
  })
  if (refused) return refused
  log.info("voice verification started", { verificationId: id })
  return { ok: true as const, verificationId: id, code, expiresAt }
}

export async function verificationStatus(userId: string, verificationId: string) {
  const [row] = await privileged
    .select()
    .from(phoneVerifications)
    .where(
      and(
        eq(phoneVerifications.id, verificationId),
        eq(phoneVerifications.userId, userId)
      )
    )
  if (!row) return fail("not_found", "That verification wasn't found.")
  const status = row.verifiedAt
    ? "verified"
    : row.tries >= VERIFICATION_TRIES
      ? "failed"
      : row.expiresAt <= clock.now()
        ? "expired"
        : "calling"
  return { ok: true as const, status }
}

export type VoicePreferences = Partial<
  Pick<
    typeof voiceProfiles.$inferInsert,
    | "timezone"
    | "quietStart"
    | "quietEnd"
    | "reportMode"
    | "reportMaxAttempts"
    | "reportRetryMinutes"
    | "transcriptRetentionDays"
  >
>

// The owner's call preferences (API §"Preferences and verification"). The
// number and its verification aren't among them: only the verification call
// sets those. The row is made with defaults first (the session may update it,
// not insert it); the change goes through the owner's own session (RLS)
export async function updatePreferences(userId: string, changes: VoicePreferences) {
  if (!(await voiceAvailable(userId))) {
    return fail("voice_unavailable", "Phone calls aren't available on your account.")
  }
  await privileged.insert(voiceProfiles).values({ userId }).onConflictDoNothing()
  if (Object.keys(changes).length > 0) {
    await withUser(userId, (tx) =>
      tx.update(voiceProfiles).set(changes).where(eq(voiceProfiles.userId, userId))
    )
  }
  return { ok: true as const }
}
