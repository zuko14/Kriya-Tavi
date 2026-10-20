import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronRightIcon, PlusIcon } from "lucide-react"

import { Mascot } from "@/components/brand"
import { StopAll } from "@/components/voice/controls"
import { requireUser } from "@/lib/auth"
import { voiceAvailable } from "@/lib/voice/tasks"
import { getCalls, type CallListItem, type CallSection } from "@/queries/voice"

export const metadata: Metadata = { title: "Calls" }

// Phone calls Tavi makes for the person (UX_AND_INTERACTION_SPEC §1, §11.6):
// live, waiting on them, coming up, done. Voice access is checked here on
// the server; without it the page doesn't exist.

const SECTIONS: { id: CallSection; title: string }[] = [
  { id: "live", title: "Live" },
  { id: "needs_you", title: "Needs you" },
  { id: "upcoming", title: "Upcoming" },
  { id: "done", title: "Done" },
]

function Row({ call }: { call: CallListItem }) {
  return (
    <li>
      <Link
        href={`/calls/${call.id}`}
        className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4 py-2.5"
      >
        <span
          aria-hidden
          className="relative grid size-9 shrink-0 place-items-center rounded-full bg-rigel-soft font-display text-[16px] text-rigel"
        >
          {call.recipient
            .replace(/^my\s+/i, "")
            .charAt(0)
            .toUpperCase()}
          {call.section === "live" && (
            <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-rigel ring-2 ring-background" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13.5px] font-medium">{call.recipient}</span>
          <span className="text-[12.5px] break-words text-muted-foreground">
            {call.line}
          </span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-faint" />
      </Link>
    </li>
  )
}

export default async function Page() {
  const user = await requireUser()
  if (!(await voiceAvailable(user.id))) notFound()
  const calls = await getCalls(user.id)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
              Calls
            </h1>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Tavi calls people for you and tells you how it went. Nobody is called until
              you confirm.
            </p>
          </div>
          {calls.length > 0 && <StopAll />}
        </header>

        <Link
          href="/calls/new"
          className="btn-liquid flex min-h-11 w-fit items-center gap-2 rounded-full px-5 text-[14px] font-medium"
        >
          <PlusIcon className="size-4" />
          New call
        </Link>

        {calls.length === 0 ? (
          <div className="glass flex flex-col items-center gap-3 rounded-[20px] px-4 py-8 text-center">
            <span className="grid size-20 place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle,#fbf5ee,#efe3d6)] ring-1 ring-black/5">
              <Mascot
                sizes="96px"
                className="w-[118%] max-w-none animate-[tavi-breathe_4s_ease-in-out_infinite]"
              />
            </span>
            <p className="max-w-sm text-[13.5px] text-muted-foreground">
              Tell Tavi who to call and what to ask. You&apos;ll confirm before
              anyone&apos;s phone rings.
            </p>
          </div>
        ) : (
          SECTIONS.map(({ id, title }) => {
            const rows = calls.filter((c) => c.section === id)
            if (rows.length === 0) return null
            return (
              <section key={id} className="flex flex-col gap-2.5">
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/70 px-1 py-1 backdrop-blur">
                  <h2 className="label-mono">{title}</h2>
                  <span className="font-mono text-[10px] text-faint tabular-nums">
                    {rows.length}
                  </span>
                </div>
                <ul className="flex flex-col gap-2">
                  {rows.map((call) => (
                    <Row key={call.id} call={call} />
                  ))}
                </ul>
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}
