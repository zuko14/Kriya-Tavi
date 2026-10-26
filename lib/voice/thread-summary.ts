import { and, asc, eq } from "drizzle-orm"

import { privileged } from "@/db"
import {
  callAttempts,
  callOutcomes,
  messages,
  threads,
  voiceCalls,
  voiceTasks,
} from "@/db/schema"

import type { CallNotes } from "./dialogue"
import { LANGUAGES } from "./languages"
import type { Interpreted } from "./outcome"
import type { VoiceTaskSpec } from "./schemas"

// When an outreach call is over, one message in the thread the call was
// drafted from (owner scenario 1): who was reached, what was asked, what
// was agreed, what's left open, and a link to the call. Built only from
// verified records: the task's own spec (the owner's words), the attempts'
// statuses, and an outcome the verifier accepted plus its in-call notes. The
// model's free-text summary is never used, and a needs-review outcome says
// so. It's history in the app, read when the person opens the thread; no
// notification is raised (D-07: nothing is added to /api/events).

// The outreach call's final states (DATA_MODEL §3.2)
const OVER = ["settled", "exhausted", "needs_owner", "blocked"]

export type SummaryFacts = {
  taskId: string
  label: string
  spec: VoiceTaskSpec
  callStatus: string
  errorCode: string | null
  attempts: {
    status: string
    requestedAt: Date | null
    connectedAt: Date | null
    endReason?: string | null
  }[]
  // The connected attempt's checked outcome, if one connected
  outcome: { status: string; interpreted: unknown } | null
}

// The callee's words reach the thread, which agents read later: quoted,
// short, and without Markdown that could make a link or a heading
const quote = (text: string) =>
  `“${text
    .replace(/[[\]()`*_#<>|~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)}”`

const NOT_PLACED: Record<string, string> = {
  suppressed: "this number asked not to be called",
  budget: "it would go over the call budget",
  not_a_test_number: "live calls are limited to test numbers for now",
}

export function summaryText(f: SummaryFacts): string {
  // For the person, in English, whatever language the call was in
  const lang = LANGUAGES["en-IN"]
  const when = (date: string, time: string) => lang.speak(date, time)
  const link = `[Open the call](/calls/${f.taskId})`
  const head = (status: string) => `**Call to ${f.label}: ${status}**`
  const goal = f.spec.goal
  const asked = [
    goal.type === "schedule_meeting"
      ? `to meet on ${when(goal.date, goal.preferred)}${goal.place ? ` at ${goal.place}` : ""}`
      : goal.type === "deliver_message"
        ? `to pass on: ${quote(goal.message)}`
        : `${quote(goal.question)}`,
    f.spec.share && `to give ${f.spec.share.label}'s number`,
  ]
    .filter(Boolean)
    .join(", and ")

  const tried = f.attempts.filter((a) => a.requestedAt)
  if (f.callStatus === "blocked" || tried.length === 0) {
    const why = NOT_PLACED[f.errorCode ?? ""]
    return [
      head("not placed"),
      `Kriya didn't place this call${why ? `: ${why}` : ""}.`,
      link,
    ].join("\n\n")
  }
  if (f.callStatus === "needs_owner" && !f.attempts.some((a) => a.connectedAt)) {
    return [
      head("needs your decision"),
      "Kriya can't confirm whether the phone rang. Check before calling again.",
      link,
    ].join("\n\n")
  }
  if (!f.outcome) {
    const at = tried.map((a) =>
      lang.clock(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: f.spec.timezone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(a.requestedAt!)
      )
    )
    const last = tried.at(-1)!
    const why =
      last.status === "busy"
        ? "the line was busy"
        : last.status === "no_answer"
          ? "there was no answer"
          : last.endReason === "voicemail"
            ? "it went to voicemail"
            : "the call didn't go through"
    return [
      head("not reached"),
      `Tried ${tried.length === 1 ? "once" : `${tried.length} times`} (${at.join(", ")}); ${why}.`,
      `- **Asked:** ${asked}`,
      link,
    ].join("\n\n")
  }
  if (f.outcome.status !== "accepted") {
    return [
      head("needs your review"),
      `Tavi spoke to ${f.label}, but the result couldn't be confirmed from the call. Please read the transcript before relying on it.`,
      `- **Asked:** ${asked}`,
      link,
    ].join("\n\n")
  }

  const o = (f.outcome.interpreted ?? {}) as Partial<Interpreted> & { notes?: CallNotes }
  const notes = o.notes
  if (notes?.end === "voicemail") {
    return [
      head("reached voicemail"),
      "A voicemail greeting or network message answered. Tavi hung up without leaving any details.",
      link,
    ].join("\n\n")
  }
  const result = o.result ?? "unclear"
  const headline = {
    agreed: "agreed",
    alternative_proposed: "suggested another time",
    declined: "declined",
    wrong_person: "wrong number",
    callback_requested: "asked to be called back",
    unclear: "no clear answer",
  }[result]
  const agreed = (o.agreed_times ?? []).find((a) => !a.superseded)
  const theirs = [
    ...new Set(
      (o.proposed_times ?? [])
        .filter(
          (t) =>
            t.by === "callee" &&
            !(agreed && t.date === agreed.date && t.time === agreed.time)
        )
        .map((t) => when(t.date, t.time))
    ),
  ]
  const shared = notes?.shared
  const open = [
    ...(o.unresolved_questions ?? []).slice(0, 3).map((q) => quote(q.question)),
    notes?.callback &&
      `Asked to be called back${notes.callback.when ? ` ${quote(notes.callback.when)}` : ""}`,
    notes?.flags.includes("emergency mentioned") &&
      "They mentioned an emergency; Tavi pointed them to 112",
    notes?.flags.includes("sensitive request") &&
      "They asked for something Tavi can't give on a call",
  ].filter(Boolean)
  const lines = [
    `- **Reached:** ${result === "wrong_person" ? "someone who said it was the wrong number" : f.label}`,
    `- **Asked:** ${asked}`,
    agreed && `- **Agreed:** ${when(agreed.date, agreed.time)}`,
    theirs.length > 0 && `- **${f.label} suggested:** ${theirs.join("; ")}`,
    shared &&
      `- **Number given:** ${shared.label}'s, ${shared.times === 1 ? "once" : `${shared.times} times`}; ${
        shared.readBack === "correct"
          ? "they read it back correctly"
          : shared.readBack === "wrong"
            ? "their last read-back didn't match, and Tavi gave the correct number again"
            : "they didn't read it back"
      }`,
    `- **Left open:** ${open.length ? open.join("; ") : "nothing"}`,
  ].filter(Boolean)
  return [head(headline), lines.join("\n"), link].join("\n\n")
}

// Posts the summary for an outreach call that's over, once (the message id
// is the call's). Safe to run again, from every path that settles a call
export async function postThreadSummary(callId: string) {
  const [row] = await privileged
    .select({ call: voiceCalls, task: voiceTasks })
    .from(voiceCalls)
    .innerJoin(
      voiceTasks,
      and(
        eq(voiceTasks.id, voiceCalls.voiceTaskId),
        eq(voiceTasks.userId, voiceCalls.userId)
      )
    )
    .where(eq(voiceCalls.id, callId))
  if (!row || row.call.kind !== "outreach" || !OVER.includes(row.call.status)) return
  const { call, task } = row
  const threadId = task.threadId
  if (!threadId) return
  const attempts = await privileged
    .select({
      id: callAttempts.id,
      status: callAttempts.status,
      requestedAt: callAttempts.requestedAt,
      connectedAt: callAttempts.connectedAt,
      endReason: callAttempts.endReason,
    })
    .from(callAttempts)
    .where(
      and(eq(callAttempts.voiceCallId, call.id), eq(callAttempts.userId, task.userId))
    )
    .orderBy(asc(callAttempts.attempt))
  // The last attempt is the news: a voicemail, then busy, is "not reached"
  const last = attempts.at(-1)
  const connected = last?.connectedAt ? last : undefined
  const [outcome] = connected
    ? await privileged
        .select({
          status: callOutcomes.verifierStatus,
          interpreted: callOutcomes.interpreted,
        })
        .from(callOutcomes)
        .where(
          and(
            eq(callOutcomes.callAttemptId, connected.id),
            eq(callOutcomes.userId, task.userId)
          )
        )
    : []
  // A connected call settles only once its outcome is checked
  if (connected && (!outcome || outcome.status === "pending")) return
  const text = summaryText({
    taskId: task.id,
    label: task.recipientLabel,
    spec: task.spec as VoiceTaskSpec,
    callStatus: call.status,
    errorCode: call.lastErrorCode,
    attempts,
    outcome: outcome ?? null,
  })
  await privileged.transaction(async (tx) => {
    const posted = await tx
      .insert(messages)
      .values({
        threadId,
        id: `voice-${call.id}`,
        userId: task.userId,
        role: "assistant",
        parts: [{ type: "text", text }],
        metadata: { voiceTaskId: task.id },
      })
      .onConflictDoNothing()
      .returning({ id: messages.id })
    if (posted.length === 0) return
    await tx
      .update(threads)
      .set({
        activeAt: new Date(),
        preview: text.split("\n")[0].replace(/\*/g, "").slice(0, 140),
      })
      .where(and(eq(threads.id, threadId), eq(threads.userId, task.userId)))
  })
}
