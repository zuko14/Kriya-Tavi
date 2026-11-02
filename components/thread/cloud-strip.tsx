"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronDownIcon, CodeXmlIcon } from "lucide-react"

import { closeWorkspace } from "@/actions/cloud"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { ThreadWorkspace } from "@/queries/cloud"

// The thread's cloud workspace in one line (UX_SPEC §2): project, branch and
// base, changed files, status; expanded, the status in words, this month's
// minutes and Close. No pause or resume: compute runs only while a task runs.

function statusOf(workspace: ThreadWorkspace) {
  if (workspace.closing) return { short: "Closing…", long: "Closing…", tone: "" }
  switch (workspace.status) {
    case "running":
      return { short: "Working", long: "Working now", tone: "text-rigel" }
    case "paused":
      return { short: "Paused", long: "Paused, ready to continue", tone: "" }
    case "failed":
      return {
        short: "Couldn't start",
        long: `Couldn't start: ${workspace.error ?? "the workspace failed"}`,
        tone: "text-destructive",
      }
    default:
      return { short: "Starting", long: "Starting…", tone: "" }
  }
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`

export function CloudStrip({ workspace }: { workspace: ThreadWorkspace }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const status = statusOf(workspace)
  const where = workspace.repo
    ? [
        workspace.repo,
        workspace.baseRef &&
          `${workspace.baseRef}${workspace.shortSha ? ` @ ${workspace.shortSha}` : ""}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Blank project"
  const changes = workspace.changes

  return (
    <Collapsible className="group/strip hairline-b shrink-0 bg-surface/40">
      <CollapsibleTrigger
        aria-label="Cloud workspace"
        className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left font-mono text-[12px] sm:px-4"
      >
        <CodeXmlIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{where}</span>
        {changes && changes.files > 0 && (
          <span className="hidden shrink-0 text-muted-foreground sm:inline">
            · {files(changes.files)}
          </span>
        )}
        <span
          className={cn("ml-auto flex shrink-0 items-center gap-1 pl-2", status.tone)}
        >
          {status.short}
          <ChevronDownIcon className="size-3.5 transition-transform group-data-open/strip:rotate-180" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3 text-[13px] sm:px-4">
        <p className={status.tone}>{status.long}</p>
        {changes && (
          <p className="font-mono text-[12px] text-muted-foreground">
            {changes.files === 0 ? (
              "No changes yet"
            ) : (
              <>
                {files(changes.files)}, <span className="text-ok">+{changes.added}</span>{" "}
                <span className="text-destructive">−{changes.removed}</span>
              </>
            )}
          </p>
        )}
        {workspace.limitMinutes > 0 && (
          <p className="text-[12.5px] text-muted-foreground">
            Cloud minutes this month: {workspace.usedMinutes} of {workspace.limitMinutes}
          </p>
        )}
        {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        {!workspace.closing && (
          <Confirm
            trigger={
              <Button
                variant="outline"
                className="min-h-11 self-start text-destructive sm:min-h-9"
              >
                Close workspace
              </Button>
            }
            title="Close this workspace?"
            description="Its saved changes are deleted. Pull requests already opened stay on GitHub."
            action="Close workspace"
            onConfirm={async () => {
              const result = await closeWorkspace(workspace.id)
              if ("error" in result) setError(result.error ?? null)
              else router.refresh()
            }}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
