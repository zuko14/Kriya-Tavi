"use client"

import { CheckIcon, ChevronRightIcon, CircleSlashIcon, XIcon } from "lucide-react"

import { Glyph } from "@/components/glyph"
import { Markdown } from "@/components/thread/markdown"
import type { ToolPart } from "@/components/thread/tool-call"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { Assignment } from "@/lib/agent/tools"
import { cn } from "@/lib/utils"

const TOOL_WORDS: Record<string, string> = {
  web_search: "searched",
  web_fetch: "read a page",
  memory_write: "saved a note",
  memory_forget: "removed a note",
}

function activity(tools: string[] | undefined) {
  if (!tools?.length) return null
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts]
    .map(([tool, n]) => `${TOOL_WORDS[tool] ?? tool}${n > 1 ? ` ×${n}` : ""}`)
    .join(" · ")
}

// A squad lead's `assign` call: every member's part, live while they work
// side by side, then each result
export function SquadWork({ part, live }: { part: ToolPart; live: boolean }) {
  const input = (part.input ?? {}) as {
    assignments?: { agentId?: string; brief?: string }[]
  }
  const output =
    part.state === "output-available"
      ? (part.output as { results?: Assignment[] } | undefined)
      : undefined
  const final = part.state === "output-available" && !part.preliminary
  // Before the first snapshot, show the briefs as they stream in
  const rows: Partial<Assignment>[] =
    output?.results ??
    (input.assignments ?? []).map((a) => ({ agentId: a.agentId, brief: a.brief }))
  const cutOff = !live && !final && part.state !== "output-error"
  const finished = rows.filter((row) => row.status === "done" || row.status === "failed")

  return (
    <section
      aria-label="Squad working in parallel"
      className="glass flex flex-col overflow-hidden rounded-2xl"
    >
      <header className="hairline-b flex items-center gap-2 px-3.5 py-2.5">
        <span className="label-mono">
          {rows.length > 0 ? `${rows.length} working in parallel` : "splitting the work…"}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {part.state === "output-error"
            ? "couldn't start"
            : cutOff
              ? "interrupted"
              : final
                ? "all back"
                : rows.length > 0
                  ? `${finished.length}/${rows.length} done`
                  : ""}
        </span>
      </header>
      {part.state === "output-error" && (
        <p className="px-3.5 py-2.5 font-mono text-[11.5px] break-words text-destructive">
          {part.errorText}
        </p>
      )}
      <ul className="divide-y">
        {rows.map((row, i) => {
          const status =
            cutOff && (row.status === "working" || !row.status) ? "stopped" : row.status
          const open = status === "done" && final && !!row.text
          const tools = activity(row.tools)
          return (
            <li key={row.agentId ?? i}>
              <Collapsible className="group/member" disabled={!open}>
                <CollapsibleTrigger className="flex min-h-14 w-full min-w-0 items-start gap-3 px-3.5 py-3 text-left enabled:hover:bg-accent/30">
                  {row.glyph ? (
                    <Glyph seed={row.glyph} className="mt-0.5 size-8 shrink-0" />
                  ) : (
                    <span className="mt-0.5 size-8 shrink-0 rounded-lg bg-muted" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-semibold">
                        {row.name ?? "Squad member"}
                      </span>
                      <span className="ml-auto grid size-4 shrink-0 place-items-center">
                        {status === "done" ? (
                          <CheckIcon className="size-3.5 text-ok" aria-label="done" />
                        ) : status === "failed" ? (
                          <XIcon
                            className="size-3.5 text-destructive"
                            aria-label="failed"
                          />
                        ) : status === "stopped" ? (
                          <CircleSlashIcon
                            className="size-3.5 text-faint"
                            aria-label="stopped"
                          />
                        ) : (
                          <Spinner className="size-3 text-rigel" />
                        )}
                      </span>
                      {open && (
                        <ChevronRightIcon className="size-3.5 shrink-0 text-faint transition-transform group-data-open/member:rotate-90" />
                      )}
                    </span>
                    {row.brief && (
                      <span className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
                        {row.brief}
                      </span>
                    )}
                    {status === "working" && row.text && (
                      <span className="line-clamp-2 font-mono text-[11px] leading-snug text-faint">
                        …{row.text.slice(-160)}
                      </span>
                    )}
                    {status === "failed" && row.error && (
                      <span className="text-[12px] break-words text-destructive">
                        {row.error}
                      </span>
                    )}
                    {tools && (
                      <span
                        className={cn(
                          "font-mono text-[10.5px] text-faint",
                          status === "working" && "shimmer-text"
                        )}
                      >
                        {tools}
                      </span>
                    )}
                  </span>
                </CollapsibleTrigger>
                {open && (
                  <CollapsibleContent className="border-t bg-background/40 px-3.5 py-3 sm:pl-[58px]">
                    <Markdown className="text-[13px]">{row.text!}</Markdown>
                  </CollapsibleContent>
                )}
              </Collapsible>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
