import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeftIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react"

import { ConfirmCard } from "@/components/voice/confirm-card"
import {
  DeleteTranscript,
  LiveUpdates,
  ReviewButton,
  StopTask,
} from "@/components/voice/controls"
import { Presence, type PresenceState } from "@/components/voice/presence"
import { requireUser } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { voiceAvailable } from "@/lib/voice/tasks"
import { getCall, type CallDetail } from "@/queries/voice"

export const metadata: Metadata = { title: "Call" }

// One call, from draft to outcome (UX_AND_INTERACTION_SPEC §3–5, §11.3–5).
// Server-rendered from the database; the live stream only tells the page to
// refresh, so reopening it loses nothing.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function presence(call: CallDetail): { state: PresenceState; words: string } {
  if (call.live?.status === "connected") {
    return { state: "talking", words: `On the call with ${call.recipient}` }
  }
  if (call.live) return { state: "dialing", words: `Calling ${call.recipient}` }
  if (call.status === "needs_owner") return { state: "attention", words: call.hero }
  if (call.status === "completed" || call.status === "unreported") {
    return { state: "done", words: call.hero }
  }
  return { state: "idle", words: call.hero }
}

function Facts({
  title,
  items,
}: {
  title: string
  items: { text: string; turn: number }[]
}) {
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="label-mono">{title}</h2>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={`${item.text}:${item.turn}`}
            className="flex flex-wrap items-baseline gap-2"
          >
            <span className="text-[14px]">{item.text}</span>
            {/* Evidence: the turn it was said in (§11.5) */}
            <a
              href={`#turn-${item.turn}`}
              className="flex min-h-11 items-center font-mono text-[11px] text-rigel hover:underline sm:min-h-0"
            >
              heard in turn {item.turn} →
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default async function Page({ params }: { params: Promise<{ taskId: string }> }) {
  const user = await requireUser()
  const { taskId } = await params
  if (!UUID.test(taskId) || !(await voiceAvailable(user.id))) notFound()
  const call = await getCall(user.id, taskId)
  if (!call) notFound()
  const now = presence(call)
  const outcome = call.terminal || call.status === "needs_owner"

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <Link
          href="/calls"
          className="flex min-h-11 w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          Calls
        </Link>

        <header className="flex flex-col gap-4">
          <h1 className="font-display text-[28px] leading-tight font-normal break-words sm:text-[34px]">
            {call.recipient}
          </h1>
          <Presence state={now.state} words={now.words} />
          <p className="text-[13px] break-words text-muted-foreground">{call.purpose}</p>
        </header>

        {call.status === "draft" && (
          <div className="flex flex-col gap-2">
            <p className="text-[13.5px]">
              This is a draft. Review the call, then confirm it; nobody is called before.
            </p>
            <ReviewButton taskId={call.id} />
          </div>
        )}
        {call.approval && <ConfirmCard taskId={call.id} approval={call.approval} />}

        {call.calls.length > 0 && (
          <ol
            aria-label="Calls"
            className="flex flex-col gap-2 border-l-2 border-hairline pl-4"
          >
            {call.calls.map((c) => (
              <li key={c.id} className="text-[13.5px]">
                {c.line}
              </li>
            ))}
          </ol>
        )}

        <LiveUpdates
          taskId={call.id}
          live={call.live !== null}
          recipient={call.recipient}
        />

        {outcome && (
          <section className="glass flex flex-col gap-4 rounded-[20px] px-4 py-5">
            <p className="font-display text-[22px] leading-snug text-balance">
              {call.hero}
            </p>
            {call.checked && (
              <span
                className={cn(
                  "flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px]",
                  call.verified
                    ? "bg-rigel-soft text-rigel"
                    : "bg-betelgeuse/15 text-betelgeuse"
                )}
              >
                {call.verified ? (
                  <ShieldCheckIcon className="size-3.5" />
                ) : (
                  <TriangleAlertIcon className="size-3.5" />
                )}
                {call.verified ? "Verified by call records" : "Needs your review"}
              </span>
            )}
            {call.lost && <p className="text-[13.5px] text-betelgeuse">{call.lost}</p>}
            <Facts
              title="Agreed"
              items={call.agreed.map((a) => ({ text: a.when, turn: a.turn }))}
            />
            <Facts
              title="They suggested"
              items={call.proposed.map((p) => ({ text: p.when, turn: p.turn }))}
            />
            <Facts
              title="Questions for you"
              items={call.questions.map((q) => ({ text: q.question, turn: q.turn }))}
            />
          </section>
        )}

        {call.turns.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="label-mono">What was said</h2>
            <ol className="flex flex-col gap-2">
              {call.turns.map((t) => (
                <li
                  key={t.seq}
                  id={`turn-${t.seq}`}
                  className="scroll-mt-20 rounded-xl px-3 py-2 target:bg-rigel-soft"
                >
                  <span className="label-mono mr-2 text-faint">
                    {t.seq} · {t.speaker}
                  </span>
                  <span
                    className={cn(
                      "text-[13.5px] break-words",
                      !t.tavi && "text-betelgeuse"
                    )}
                  >
                    {t.text}
                  </span>
                  {t.cutOff && (
                    <span className="ml-1 text-[12px] text-muted-foreground">
                      (cut off)
                    </span>
                  )}
                </li>
              ))}
            </ol>
            <DeleteTranscript taskId={call.id} />
          </section>
        )}

        {!call.terminal && <StopTask taskId={call.id} live={call.live !== null} />}
      </div>
    </div>
  )
}
