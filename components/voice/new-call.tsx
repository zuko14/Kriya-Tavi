"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { draftCall, extractCallDraft } from "@/actions/voice"
import { useDictation } from "@/components/thread/dictation"
import { Presence } from "@/components/voice/presence"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// Asking Tavi for a call (UX_AND_INTERACTION_SPEC §2, §3, §11.2): speak or
// type, the server works out a draft and says what's missing, each gap is
// asked as a plain question, then draftCall stores it and the person goes
// on to confirm. Nothing is called from this screen.

type Draft = {
  recipientLabel?: string
  recipientName?: string
  recipientPhone?: string
  purpose?: string
  goal?:
    | {
        type: "schedule_meeting"
        date: string
        preferred: string
        acceptable: { from: string; to: string }[]
      }
    | { type: "deliver_message"; message: string; askForReply: boolean }
    | { type: "ask_question"; question: string }
  authority?: { mayAcceptWithinAcceptable: boolean; mayProposeAlternatives: boolean }
}

// The questions of §3, one per missing field
const ASK: Record<string, string> = {
  phone: "What number should I call?",
  recipient: "Who is this? (e.g. my CA)",
  goal: "What should I ask or say?",
  date: "Which day?",
  preferred_time: "What time should I ask for?",
  acceptable_window: "Which other times are OK if that doesn't work?",
  ambiguous_date: "You said “tomorrow” close to midnight. Which day did you mean?",
}
const FIELD_OF: Record<string, string> = {
  phone: "field-phone",
  recipient: "field-label",
  goal: "field-goal",
  date: "field-date",
  preferred_time: "field-time",
  acceptable_window: "field-from",
  ambiguous_date: "field-date",
}

// The +91 form the server will use, shown as typed (§3)
const normalised = (raw: string) => {
  const d = raw.replace(/[\s()-]/g, "").replace(/^(\+91|91|0)(?=[6-9]\d{9}$)/, "")
  return /^[6-9]\d{9}$/.test(d) ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : null
}

const tap = "min-h-11"

function Field({
  id,
  label,
  missing,
  children,
}: {
  id: string
  label: string
  missing?: boolean
  children: React.ReactNode
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className={cn("text-[13px] font-medium", missing && "text-betelgeuse")}>
        {label}
      </span>
      {children}
    </label>
  )
}

export function NewCall() {
  const router = useRouter()
  const [text, setText] = React.useState("")
  const [interim, setInterim] = React.useState("")
  const [problem, setProblem] = React.useState<string | null>(null)
  const [level, setLevel] = React.useState(0)
  const [thinking, setThinking] = React.useState(false)
  const [missing, setMissing] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [fields, setFields] = React.useState<Record<string, string>>({})
  const [saving, start] = React.useTransition()
  const [key] = React.useState(() => crypto.randomUUID())
  const base = React.useRef("")
  const decay = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const dictation = useDictation({
    onText: (final, heard) => {
      setText(`${base.current}${base.current && final ? " " : ""}${final}`.trimStart())
      setInterim(heard)
      // The ring pulses as words arrive (§11.2; no microphone level is read)
      setLevel(1)
      clearTimeout(decay.current)
      decay.current = setTimeout(() => setLevel(0), 220)
    },
    onProblem: setProblem,
  })
  const listening = dictation.state === "listening" || dictation.state === "starting"
  const toggle = () => {
    setProblem(null)
    if (listening) return dictation.stop()
    base.current = text
    void dictation.start()
  }

  const set = (name: string) => (value: string) =>
    setFields((all) => ({ ...all, [name]: value }))
  const f = (name: string) => fields[name] ?? ""

  const extract = async () => {
    if (listening) dictation.stop()
    setError(null)
    setThinking(true)
    try {
      const result = await extractCallDraft(text)
      if (!result.ok) return setError(result.message)
      const d = result.draft as Draft
      const g = d.goal
      const meeting = g?.type === "schedule_meeting" ? g : null
      setFields({
        label: d.recipientLabel ?? "",
        name: d.recipientName ?? "",
        phone: d.recipientPhone ?? "",
        purpose: d.purpose ?? text,
        type: g?.type ?? "schedule_meeting",
        date: meeting?.date ?? "",
        time: meeting?.preferred ?? "",
        from: meeting?.acceptable[0]?.from ?? "",
        to: meeting?.acceptable[0]?.to ?? "",
        message: g?.type === "deliver_message" ? g.message : "",
        question: g?.type === "ask_question" ? g.question : "",
        accept: d.authority?.mayAcceptWithinAcceptable ? "yes" : "",
        propose: d.authority?.mayProposeAlternatives ? "yes" : "",
      })
      setMissing(result.missing)
    } catch {
      setError("That didn't go through. Try again.")
    } finally {
      setThinking(false)
    }
  }

  const save = () =>
    start(async () => {
      setError(null)
      const type = f("type") || "schedule_meeting"
      const range = f("from") && f("to") ? [{ from: f("from"), to: f("to") }] : []
      const result = await draftCall({
        idempotencyKey: key,
        recipientLabel: f("label"),
        ...(f("name") && { recipientName: f("name") }),
        recipientPhone: f("phone"),
        purpose: f("purpose") || text,
        goal:
          type === "deliver_message"
            ? { type, message: f("message"), askForReply: true }
            : type === "ask_question"
              ? { type, question: f("question") }
              : { type, date: f("date"), preferred: f("time"), acceptable: range },
        authority: {
          mayAcceptWithinAcceptable: f("accept") === "yes",
          mayProposeAlternatives: f("propose") === "yes",
          mayShareOwnerPhone: false,
          mayDiscuss: [],
        },
        mustNot: [],
      })
      if (result.ok) return router.push(`/calls/${result.taskId}`)
      const detail = result.fields ? Object.values(result.fields) : []
      setError([result.message, ...detail].join(" "))
    })

  const type = f("type") || "schedule_meeting"
  const words = listening
    ? "Listening…"
    : thinking
      ? "Working out the details"
      : missing
        ? "Check the details, then save the draft"
        : "Tell me who to call and what to ask"

  return (
    <div className="flex flex-col gap-5">
      <Presence
        state={listening ? "listening" : thinking ? "thinking" : "idle"}
        words={words}
        level={level}
        onPress={dictation.state === "unsupported" ? undefined : toggle}
        pressLabel={listening ? "Stop dictation" : "Speak your request"}
      />

      <div className="flex flex-col gap-1.5">
        <Textarea
          aria-label="Your request"
          value={interim ? `${text} ${interim}` : text}
          onChange={(e) => setText(e.target.value)}
          readOnly={listening}
          rows={4}
          maxLength={2000}
          placeholder="Call my CA on 98765 43210 and ask whether 3 PM tomorrow works. Anything between 2 and 5 is fine."
          className={cn("text-[15px]", interim && "font-display")}
        />
        <p className="text-[12px] text-muted-foreground">
          {dictation.state === "unsupported"
            ? "Voice typing isn't available in this browser; type instead."
            : dictation.local
              ? "On-device"
              : "Speech uses your browser's speech service (Google's in Chrome)."}
        </p>
        {problem && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {problem}
          </p>
        )}
      </div>

      {!missing && (
        <button
          type="button"
          disabled={!text.trim() || thinking}
          onClick={extract}
          className="btn-liquid min-h-11 w-fit rounded-full px-5 text-[14px] font-medium"
        >
          Continue
        </button>
      )}

      {missing && (
        <form
          className="glass flex flex-col gap-4 rounded-[20px] px-4 py-5"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          {missing.length > 0 && (
            <ul className="flex flex-col gap-1">
              {missing.map((m) => (
                <li key={m}>
                  <a
                    href={`#${FIELD_OF[m]}`}
                    className="flex min-h-11 items-center text-[13.5px] font-medium text-betelgeuse"
                  >
                    {ASK[m] ?? m}
                  </a>
                </li>
              ))}
            </ul>
          )}

          <Field id="field-phone" label="Number" missing={missing.includes("phone")}>
            <Input
              id="field-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              className={tap}
              value={f("phone")}
              onChange={(e) => set("phone")(e.target.value)}
            />
            {normalised(f("phone")) && (
              <span className="font-mono text-[12px] text-muted-foreground">
                Will call {normalised(f("phone"))}
              </span>
            )}
          </Field>
          <Field
            id="field-label"
            label="Who is it?"
            missing={missing.includes("recipient")}
          >
            <Input
              id="field-label"
              className={tap}
              placeholder="my CA"
              value={f("label")}
              onChange={(e) => set("label")(e.target.value)}
            />
          </Field>
          <Field id="field-goal" label="What for?" missing={missing.includes("goal")}>
            <select
              id="field-goal"
              className="min-h-11 rounded-md border bg-transparent px-3 text-[14px]"
              value={type}
              onChange={(e) => set("type")(e.target.value)}
            >
              <option value="schedule_meeting">Fix a meeting time</option>
              <option value="deliver_message">Pass on a message</option>
              <option value="ask_question">Ask a question</option>
            </select>
          </Field>

          {type === "schedule_meeting" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  id="field-date"
                  label="Day"
                  missing={missing.includes("date") || missing.includes("ambiguous_date")}
                >
                  <Input
                    id="field-date"
                    type="date"
                    className={tap}
                    value={f("date")}
                    onChange={(e) => set("date")(e.target.value)}
                  />
                </Field>
                <Field
                  id="field-time"
                  label="Time to ask for"
                  missing={missing.includes("preferred_time")}
                >
                  <Input
                    id="field-time"
                    type="time"
                    className={tap}
                    value={f("time")}
                    onChange={(e) => set("time")(e.target.value)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  id="field-from"
                  label="Also OK from"
                  missing={missing.includes("acceptable_window")}
                >
                  <Input
                    id="field-from"
                    type="time"
                    className={tap}
                    value={f("from")}
                    onChange={(e) => set("from")(e.target.value)}
                  />
                </Field>
                <Field id="field-to" label="until">
                  <Input
                    id="field-to"
                    type="time"
                    className={tap}
                    value={f("to")}
                    onChange={(e) => set("to")(e.target.value)}
                  />
                </Field>
              </div>
              {(["accept", "propose"] as const).map((name) => (
                <label
                  key={name}
                  className="flex min-h-11 items-center gap-2 text-[13.5px]"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--rigel)]"
                    checked={f(name) === "yes"}
                    onChange={(e) => set(name)(e.target.checked ? "yes" : "")}
                  />
                  {name === "accept"
                    ? "Tavi may agree to a time in that range"
                    : "Tavi may suggest times in that range"}
                </label>
              ))}
            </>
          )}
          {type === "deliver_message" && (
            <Field id="field-message" label="Message">
              <Textarea
                id="field-message"
                rows={3}
                maxLength={500}
                value={f("message")}
                onChange={(e) => set("message")(e.target.value)}
              />
            </Field>
          )}
          {type === "ask_question" && (
            <Field id="field-question" label="Question">
              <Textarea
                id="field-question"
                rows={2}
                maxLength={300}
                value={f("question")}
                onChange={(e) => set("question")(e.target.value)}
              />
            </Field>
          )}

          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className={tap} disabled={saving}>
              Save draft
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={tap}
              onClick={() => setMissing(null)}
            >
              Change the request
            </Button>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Nobody is called until you confirm on the next screen.
          </p>
        </form>
      )}
      {!missing && error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
