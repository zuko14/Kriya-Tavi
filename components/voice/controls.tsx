"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PhoneOffIcon, Trash2Icon } from "lucide-react"

import {
  askToConfirmCall,
  cancelCall,
  deleteCallTranscript,
  stopAllCalls,
} from "@/actions/voice"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Buttons and live updates for the calls screens (UX_AND_INTERACTION_SPEC
// §3–5, §9, §11.4). Each calls a server action, shows a plain error if it
// fails, and refreshes the server-rendered page when it works: what the
// person sees always comes from the database.

const tap = "min-h-11"

const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-[12.5px] text-destructive">
      {error}
    </p>
  ) : null

function useRun() {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [pending, start] = React.useTransition()
  const run = (work: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null)
      try {
        const result = await work()
        if (!result.ok) setError(result.message ?? "That didn't go through.")
        router.refresh()
      } catch {
        setError("That didn't go through. Try again.")
      }
    })
  return { error, pending, run }
}

// A draft → its confirmation card (§3)
export function ReviewButton({ taskId }: { taskId: string }) {
  const { error, pending, run } = useRun()
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => askToConfirmCall(taskId))}
        className="btn-liquid min-h-11 w-fit rounded-full px-5 text-[14px] font-medium"
      >
        Review and confirm
      </button>
      <Problem error={error} />
    </div>
  )
}

// Always there while a task isn't finished (§4)
export function StopTask({ taskId, live }: { taskId: string; live: boolean }) {
  const { error, run } = useRun()
  return (
    <div className="flex flex-col gap-1.5">
      <Confirm
        trigger={
          <Button variant="destructive" className={tap}>
            <PhoneOffIcon data-icon="inline-start" />
            {live ? "Stop and hang up" : "Stop"}
          </Button>
        }
        title={live ? "Stop and hang up?" : "Stop this call?"}
        description={
          live
            ? "Tavi hangs up within a few seconds and won't call again for this."
            : "Nothing more will be called for this."
        }
        action={live ? "Stop and hang up" : "Stop"}
        onConfirm={() => run(() => cancelCall(taskId))}
      />
      <Problem error={error} />
    </div>
  )
}

// Every open voice task, at once (§9)
export function StopAll() {
  const router = useRouter()
  const [said, setSaid] = React.useState<string | null>(null)
  return (
    <div className="flex flex-col items-end gap-1">
      <Confirm
        trigger={
          <Button variant="outline" className={cn(tap, "text-destructive")}>
            Stop all calls
          </Button>
        }
        title="Stop all calls?"
        description="Every call waiting to happen is cancelled, and a live call is hung up within seconds."
        action="Stop all"
        onConfirm={async () => {
          const result = await stopAllCalls()
          setSaid(
            `Stopped ${result.cancelled} ${result.cancelled === 1 ? "task" : "tasks"}.`
          )
          router.refresh()
        }}
      />
      {said && (
        <p role="status" className="text-[12.5px] text-muted-foreground">
          {said}
        </p>
      )}
    </div>
  )
}

export function DeleteTranscript({ taskId }: { taskId: string }) {
  const { error, run } = useRun()
  return (
    <div className="flex flex-col gap-1.5">
      <Confirm
        trigger={
          <Button variant="ghost" className={cn(tap, "w-fit text-muted-foreground")}>
            <Trash2Icon data-icon="inline-start" />
            Delete transcript
          </Button>
        }
        title="Delete what was said?"
        description="The transcript of this call is deleted for good. The result above stays."
        action="Delete"
        onConfirm={() => run(() => deleteCallTranscript(taskId))}
      />
      <Problem error={error} />
    </div>
  )
}

type Turn = { id: string; speaker: string; text: string }

// Follows the task's stream (API §4) and refreshes the page on each change;
// closing the tab loses nothing (§11.4). Captions are opt-in and show the
// last two stored turns (§11.4)
export function LiveUpdates({
  taskId,
  live,
  recipient,
}: {
  taskId: string
  live: boolean
  recipient: string
}) {
  const router = useRouter()
  const [captions, setCaptions] = React.useState(false)
  const [turns, setTurns] = React.useState<Turn[]>([])
  React.useEffect(() => {
    const source = new EventSource(
      `/api/voice/tasks/${taskId}/stream${captions ? "?transcript=1" : ""}`
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as { type: string } & Turn
      if (event.type === "turn") {
        setTurns((all) => [...all.filter((t) => t.id !== event.id), event].slice(-2))
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => router.refresh(), 250)
    }
    return () => {
      clearTimeout(timer)
      source.close()
    }
  }, [taskId, captions, router])

  if (!live) return null
  return (
    <div className="flex flex-col gap-2">
      <label className="flex min-h-11 w-fit items-center gap-2 text-[13px] text-muted-foreground">
        <input
          type="checkbox"
          className="size-4 accent-[var(--rigel)]"
          checked={captions}
          onChange={(e) => {
            setTurns([])
            setCaptions(e.target.checked)
          }}
        />
        Show what&apos;s being said
      </label>
      {captions && (
        // Fixed height: captions arriving never push the page around (§11.7)
        <ol
          role="log"
          aria-label="Live captions"
          className="glass flex h-24 flex-col justify-end gap-1 overflow-hidden rounded-2xl px-4 py-3 text-[13.5px]"
        >
          {turns.map((t) => (
            <li
              key={t.id}
              className={cn(
                "rise truncate",
                t.speaker === "tavi" ? "text-foreground" : "text-betelgeuse"
              )}
            >
              <span className="label-mono mr-2 text-faint">
                {t.speaker === "tavi" ? "Tavi" : recipient}
              </span>
              {t.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
