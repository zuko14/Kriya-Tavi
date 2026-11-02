"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// One terminal command to copy, as on the Kriya Harness page
export function Command({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-xl border bg-background/60 pl-3.5",
        className
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
        <span aria-hidden className="mr-2 text-faint select-none">
          $
        </span>
        {command}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : `Copy ${command}`}
        onClick={async () => {
          await navigator.clipboard.writeText(command).catch(() => {})
          setCopied(true)
        }}
        className="grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? (
          <CheckIcon className="size-4 text-ok" />
        ) : (
          <CopyIcon className="size-4" />
        )}
      </button>
    </div>
  )
}
