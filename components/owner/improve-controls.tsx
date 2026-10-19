"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { advanceVersion, rollbackVersion } from "@/actions/improve"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"

// Promotion and rollback of a policy version (A12)

const tap = "min-h-11 sm:min-h-8"

export function VersionControls({
  id,
  next,
  canRollBack,
}: {
  id: string
  // Label of the next step, or null when the version can't move on
  next: string | null
  canRollBack: boolean
}) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const run = async (action: (id: string) => Promise<{ error?: string }>) => {
    const result = await action(id)
    setError(result.error ?? null)
    router.refresh()
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {next && (
        <Confirm
          trigger={
            <Button size="xs" className={tap}>
              {next}
            </Button>
          }
          title={`${next}?`}
          description="People in the canary's share start using this bundle on their next task. The step is written to the audit log; the worker rolls it back by itself if its guard metrics worsen."
          action={next}
          onConfirm={() => run(advanceVersion)}
        />
      )}
      {canRollBack && (
        <Confirm
          trigger={
            <Button size="xs" variant="destructive" className={tap}>
              Roll back
            </Button>
          }
          title="Roll this version back?"
          description="Its people return to the version that was active before (or the code baseline) on their next task. This can't be undone; propose it again to retry."
          action="Roll back"
          onConfirm={() => run(rollbackVersion)}
        />
      )}
      {error && (
        <span role="alert" className="text-[12px] text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}
