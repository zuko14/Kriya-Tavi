"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, CheckIcon, ClockIcon, Trash2Icon, XIcon } from "lucide-react"

import {
  acceptEdit,
  addEditNote,
  cancelEdit,
  removeEditNote,
  sendEditNotes,
} from "@/actions/editing"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// The Review Room (TAVI_INTEGRATION §6): built for a phone. Watch a cut, pin notes to
// moments, send them as one revision, or say it looks good. What's shown about the
// checks is what the computer reported, and it's labelled so (§10).

const FLICKS = 705_600_000
const clock = (flicks: number) => {
  const seconds = Math.floor(flicks / FLICKS)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

const OPEN = ["queued", "running", "lost"]
const STATUS: Record<string, string> = {
  queued: "Waiting for your computer",
  running: "Being made on your computer",
  delivered: "Checked on your computer",
  delivered_with_notes: "Checked on your computer, with notes",
  blocked: "A check on your computer blocked this cut",
  failed: "This cut failed",
  canceled: "Canceled",
  expired: "Your computer didn't pick this up",
  lost: "Your computer has gone quiet",
}

type Cut = {
  id: string
  status: string
  label: string
  preview: { id: string; durationFlicks: number | null } | null
}
type Note = {
  id: string
  atFlicks: number
  body: string
  status: string
  // Sent into this cut, from the one before it
  inThisCut: boolean
}

export function ReviewRoom({
  job,
  cuts,
  notes,
}: {
  job: {
    id: string
    brief: string
    status: string
    stage: string | null
    percent: number | null
    acceptedAt: Date | null
    verdict: Record<string, unknown> | null
  }
  cuts: Cut[]
  notes: Note[]
}) {
  const router = useRouter()
  const video = React.useRef<HTMLVideoElement>(null)
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState("")
  const [now, setNow] = React.useState(0)
  const [length, setLength] = React.useState(0)
  const [picked, setShown] = React.useState<string | null>(null)
  // A cut still being made shows the moment its preview arrives; a chosen one stays chosen
  const shown = picked ?? job.id
  const playing = cuts.find((cut) => cut.id === shown)?.preview ?? null
  const open = OPEN.includes(job.status)

  // A cut in the making shows its progress without a reload
  React.useEffect(() => {
    if (!open) return
    const timer = setInterval(() => router.refresh(), 10_000)
    return () => clearInterval(timer)
  }, [open, router])

  // Comparing keeps your place: the other cut opens at the same moment
  const resume = React.useRef(0)
  const compare = (id: string) => {
    resume.current = video.current?.currentTime ?? 0
    setShown(id)
  }
  const act = (work: () => Promise<{ error?: string } | { ok: true }>) =>
    start(async () => {
      setError(null)
      const result = await work()
      if ("error" in result && result.error) setError(result.error)
      router.refresh()
    })

  const live = notes.filter((note) => note.status === "open")
  const verdict = (job.verdict ?? {}) as { applied?: number; skipped?: number }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4">
      <header className="flex items-center gap-2">
        <Link
          href="/edits"
          aria-label="All edits"
          className="grid size-11 shrink-0 place-items-center rounded-xl hover:bg-accent/50"
        >
          <ArrowLeftIcon className="size-4" />
        </Link>
        <h1 className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug font-semibold">
          {job.brief}
        </h1>
      </header>

      {cuts.filter((cut) => cut.preview).length > 1 && (
        <div role="group" aria-label="Compare cuts" className="flex flex-wrap gap-2">
          {cuts
            .filter((cut) => cut.preview)
            .map((cut) => (
              <button
                key={cut.id}
                type="button"
                aria-pressed={cut.id === shown}
                onClick={() => compare(cut.id)}
                className={cn(
                  "min-h-11 rounded-xl border px-4 text-[13px] font-medium",
                  cut.id === shown && "border-rigel bg-rigel-soft text-rigel"
                )}
              >
                {cut.label}
              </button>
            ))}
        </div>
      )}

      {playing ? (
        <div className="flex flex-col gap-2">
          {/* The person's own preview; it has no captions track of its own yet */}
          <video
            key={playing.id}
            ref={video}
            src={`/api/editing/preview/${playing.id}`}
            controls
            playsInline
            preload="metadata"
            className="aspect-video max-h-[60svh] w-full rounded-2xl bg-black object-contain"
            onLoadedMetadata={(event) => {
              setLength(event.currentTarget.duration)
              if (resume.current) event.currentTarget.currentTime = resume.current
            }}
            onTimeUpdate={(event) => setNow(event.currentTarget.currentTime)}
          />
          {length > 0 && (
            <div aria-hidden className="relative h-2 rounded-full bg-accent/60">
              {notes
                .filter((note) => !note.inThisCut)
                .map((note) => (
                  <span
                    key={note.id}
                    className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-betelgeuse"
                    style={{
                      left: `${Math.min(100, ((note.atFlicks / FLICKS) * 100) / length)}%`,
                    }}
                  />
                ))}
            </div>
          )}
        </div>
      ) : (
        <p className="glass rounded-[20px] px-4 py-8 text-center text-[13px] leading-relaxed text-muted-foreground">
          {open
            ? "No preview yet. It appears here when your computer finishes."
            : "No preview was kept here. The file is on your computer, in the project's exports folder."}
        </p>
      )}

      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        {job.status.startsWith("delivered") && (
          <CheckIcon className="size-4 text-rigel" />
        )}
        <span>
          {STATUS[job.status] ?? job.status}
          {job.status === "running" && job.percent !== null && `, ${job.percent}%`}
          {verdict.applied ? `. Took ${verdict.applied} of your notes` : ""}
          {verdict.skipped ? `. Couldn't do ${verdict.skipped}` : ""}
        </span>
      </p>

      {open && (
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={() => act(() => cancelEdit(job.id))}
        >
          <XIcon data-icon="inline-start" />
          Stop this edit
        </Button>
      )}

      {notes.length > 0 && (
        <ul className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
          {notes.map((note) => (
            <li key={note.id} className="flex items-center gap-1 pl-1">
              <button
                type="button"
                aria-label={`Go to ${clock(note.atFlicks)}`}
                onClick={() => {
                  if (video.current) video.current.currentTime = note.atFlicks / FLICKS
                }}
                className="min-h-11 shrink-0 rounded-lg px-3 font-mono text-[12px] text-rigel"
              >
                {clock(note.atFlicks)}
              </button>
              <span className="min-w-0 flex-1 py-2.5 text-[13.5px] leading-snug break-words">
                {note.body}
                {note.status !== "open" && (
                  <span className="ml-2 text-[11.5px] text-faint">
                    {note.inThisCut
                      ? "asked for in this cut"
                      : note.status === "sent"
                        ? "sent"
                        : "in a later cut"}
                  </span>
                )}
              </span>
              {note.status === "open" && (
                <button
                  type="button"
                  aria-label="Remove this note"
                  disabled={pending}
                  onClick={() => act(() => removeEditNote(note.id))}
                  className="grid size-11 shrink-0 place-items-center text-muted-foreground"
                >
                  <Trash2Icon className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!open && !job.acceptedAt && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const body = draft
            const atFlicks = Math.round((video.current?.currentTime ?? 0) * FLICKS)
            start(async () => {
              setError(null)
              const result = await addEditNote({ jobId: job.id, atFlicks, body })
              if ("error" in result && result.error) setError(result.error)
              else setDraft("")
              router.refresh()
            })
          }}
        >
          <label htmlFor="edit-note" className="flex items-center gap-1.5 text-[12.5px]">
            <ClockIcon className="size-3.5" />A note at {clock(now * FLICKS)}
          </label>
          <Textarea
            id="edit-note"
            value={draft}
            maxLength={1000}
            rows={2}
            placeholder="Bigger captions here"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            className="min-h-11"
            disabled={pending || !draft.trim()}
          >
            Add note
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      {!open &&
        (job.acceptedAt ? (
          <p className="text-[13px] text-muted-foreground">
            You said this one looks good.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 flex-1"
              disabled={pending || live.length === 0}
              onClick={() =>
                act(async () => {
                  const result = await sendEditNotes(job.id)
                  if ("id" in result && result.id) router.push(`/edits/${result.id}`)
                  return result
                })
              }
            >
              {live.length === 0
                ? "Send notes"
                : `Send ${live.length} ${live.length === 1 ? "note" : "notes"}`}
            </Button>
            <Button
              variant="outline"
              className="min-h-11 flex-1"
              disabled={pending}
              onClick={() => act(() => acceptEdit(job.id))}
            >
              Looks good
            </Button>
          </div>
        ))}
    </div>
  )
}
