"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

// The thread a call was drafted in shows its summary as soon as the call is
// over (voice D-23): while the task is still open, this listens on its own
// status stream and refreshes the thread once, when the task ends. Nothing
// is shown and no notification is raised (D-07); a call already over when
// the thread opens closes the stream at once.

const OVER = [
  "awaiting_report",
  "completed",
  "needs_owner",
  "failed",
  "unreported",
  "cancelled",
  "expired",
]
// The summary is written just after the task moves on (settleCall)
export const SETTLE_MS = 1_500

type Source = { onmessage: ((m: MessageEvent) => void) | null; close(): void }

// Returns the cleanup; open is EventSource in the browser, a fake in tests
export function watchTask(
  taskId: string,
  open: (url: string) => Source,
  refresh: () => void
) {
  const source = open(`/api/voice/tasks/${taskId}/stream`)
  let first = true
  let timer: ReturnType<typeof setTimeout> | undefined
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as { type: string; status?: string }
    if (event.type !== "task") return
    const over = OVER.includes(event.status ?? "")
    if (over && !first) timer = setTimeout(refresh, SETTLE_MS)
    if (over) source.close()
    first = false
  }
  return () => {
    clearTimeout(timer)
    source.close()
  }
}

export function ThreadCallWatch({ taskId }: { taskId: string }) {
  const router = useRouter()
  React.useEffect(
    () =>
      watchTask(
        taskId,
        (url) => new EventSource(url),
        () => router.refresh()
      ),
    [taskId, router]
  )
  return null
}
