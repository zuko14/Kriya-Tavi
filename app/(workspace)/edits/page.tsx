import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import { ClapperboardIcon } from "lucide-react"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { listEdits } from "@/queries/editing"

export const metadata: Metadata = { title: "Edits" }

const LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  delivered: "Ready",
  delivered_with_notes: "With notes",
  blocked: "Blocked",
  failed: "Failed",
  canceled: "Canceled",
  expired: "Not started",
  lost: "Lost touch",
}

// Track E: every edit made on the person's computers. Gone with editing.tavi off; a row
// opens only with the Review Room on.
export default async function Page() {
  const user = await requireUser()
  if ((await getSetting("editing.tavi")) !== "on") notFound()
  const [edits, review] = await Promise.all([
    listEdits(user.id, 50),
    getSetting("editing.review"),
  ])
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Edits</h1>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Cuts made on your computer. Your footage stays there; only a small preview
            comes here. Whether a cut passed its checks is what that computer reported.
          </p>
        </header>
        {edits.length === 0 ? (
          <p className="glass rounded-[20px] px-4 py-8 text-center text-[13px] leading-relaxed text-muted-foreground">
            No edits yet. Ask an agent to cut something.
          </p>
        ) : (
          <ul className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
            {edits.map((edit) => {
              const body = (
                <>
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-rigel-soft text-rigel">
                    <ClapperboardIcon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                    <span className="truncate text-[13.5px] font-medium">
                      {edit.brief}
                    </span>
                    <span className="truncate text-[12px] text-muted-foreground">
                      {edit.device} ·{" "}
                      {formatDistanceToNowStrict(edit.createdAt, { addSuffix: true })}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    {edit.status === "running" && edit.percent !== null
                      ? `${edit.percent}%`
                      : LABEL[edit.status]}
                  </span>
                </>
              )
              const classes = "flex min-h-14 items-center gap-3 px-4 py-2.5"
              return (
                <li key={edit.id}>
                  {review === "on" ? (
                    <Link
                      href={`/edits/${edit.id}`}
                      className={`${classes} transition-colors hover:bg-accent/40`}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={classes}>{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
