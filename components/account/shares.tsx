"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { revokeShare } from "@/actions/share"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"

// Account → Shared links (K8): each link the person made, how often it was
// opened, until when, and Revoke. The links themselves were shown once.

export type ShareItem = {
  id: string
  title: string
  expiresAt: Date
  revokedAt: Date | null
  views: number
  createdAt: Date
}

const DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
})

export function Shares({ shares }: { shares: ShareItem[] }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  // Rendered on the server; "now" only decides the label
  const [now] = React.useState(() => Date.now())

  if (shares.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Nothing shared. Use Share on a receipt to send a read-only copy that expires.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
      <ul className="flex flex-col divide-y rounded-xl border">
        {shares.map((s) => {
          const live = !s.revokedAt && new Date(s.expiresAt).getTime() > now
          return (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px]">{s.title}</span>
                <span className="font-mono text-[10.5px] text-faint">
                  {s.views.toLocaleString("en-IN")} {s.views === 1 ? "view" : "views"} ·{" "}
                  {s.revokedAt
                    ? `revoked ${DATE.format(new Date(s.revokedAt))}`
                    : live
                      ? `expires ${DATE.format(new Date(s.expiresAt))}`
                      : `expired ${DATE.format(new Date(s.expiresAt))}`}
                </span>
              </div>
              {live && (
                <Confirm
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="min-h-11 sm:min-h-6"
                    >
                      Revoke
                    </Button>
                  }
                  title="Revoke this link?"
                  description="Anyone who opens it afterwards sees nothing. This can't be undone."
                  action="Revoke"
                  onConfirm={async () => {
                    const result = await revokeShare(s.id)
                    setError("error" in result && result.error ? result.error : null)
                    router.refresh()
                  }}
                />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
