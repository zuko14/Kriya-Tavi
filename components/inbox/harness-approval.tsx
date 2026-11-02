"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"

import { answerHarnessApproval } from "@/actions/harness"
import { Button } from "@/components/ui/button"

// A Kriya Harness device asks to run a tool (track H, H5; UX_SPEC §1,
// HS-7): the card shows the tool, the exact input (redacted) and the
// folder, not only the device's summary, so the person answers what will
// actually run. The device fails closed when the request expires.

const tap = "min-h-11 sm:min-h-8"

function useNow(every: number) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

export function HarnessApproval({
  item,
}: {
  item: {
    id: string
    tool: string
    summary: string
    input: Record<string, unknown> | null
    cwd: string | null
    deviceName: string
    expiresAt: Date
  }
}) {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const expired = useNow(15_000) >= item.expiresAt.getTime()
  const answer = (decision: "approved" | "declined") =>
    start(async () => {
      setError(null)
      const result = await answerHarnessApproval(item.id, decision)
      if ("error" in result) setError(result.error ?? null)
      router.refresh()
    })

  return (
    <li className="glass flex flex-col gap-3 rounded-[20px] px-4 py-4">
      <div className="flex items-center gap-2">
        <span className="label-mono text-faint">Kriya Harness · {item.deviceName}</span>
        <span className="ml-auto rounded-full bg-betelgeuse/15 px-2 py-0.5 font-mono text-[10.5px] text-betelgeuse">
          Runs on your computer
        </span>
      </div>
      <h3 className="text-[14.5px] leading-snug font-medium">
        Your laptop agent wants to run <code className="font-mono">{item.tool}</code>
      </h3>
      <p className="text-[13px] text-muted-foreground">{item.summary}</p>
      <pre className="max-h-60 overflow-auto rounded-xl border px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
        {JSON.stringify(item.input ?? {}, null, 2)}
      </pre>
      {item.cwd && (
        <p className="font-mono text-[11.5px] break-all text-muted-foreground">
          in {item.cwd}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-2">
            <Button
              className={tap}
              disabled={pending || expired}
              onClick={() => answer("approved")}
            >
              Approve once
            </Button>
            <Button
              className={tap}
              variant="outline"
              disabled={pending || expired}
              onClick={() => answer("declined")}
            >
              Decline
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
        </div>
        {/* The server's clock and the browser's differ by the render time */}
        <span className="font-mono text-[11px] text-faint" suppressHydrationWarning>
          {expired
            ? "expired"
            : `expires ${formatDistanceToNowStrict(item.expiresAt, { addSuffix: true })}`}
        </span>
      </div>
    </li>
  )
}
