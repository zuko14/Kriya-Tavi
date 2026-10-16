import Link from "next/link"
import { formatDistanceToNowStrict } from "date-fns"
import { ChevronRightIcon, PlusIcon } from "lucide-react"

import { Mascot } from "@/components/brand"
import { Glyph, SquadGlyph } from "@/components/glyph"
import { NewAgentCard, TemplateGrid } from "@/components/home/actions"
import { Ask } from "@/components/home/ask"
import { UsageMeter } from "@/components/home/usage-meter"
import { requireUser } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { getNavigation, getSystemStatus } from "@/queries/workspace"

function SectionTitle({ children, href }: { children: React.ReactNode; href?: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="label-mono">{children}</h2>
      <span className="h-px flex-1 bg-hairline" />
      {href && (
        <Link
          href={href}
          className="flex min-h-11 items-center gap-0.5 text-[12.5px] text-muted-foreground hover:text-foreground sm:min-h-0"
        >
          See all
          <ChevronRightIcon className="size-3.5" />
        </Link>
      )}
    </div>
  )
}

export default async function Home() {
  const user = await requireUser()
  const [status, nav] = await Promise.all([getSystemStatus(user), getNavigation(user.id)])
  const firstName = user.profile.displayName?.split(" ")[0]
  const hasAgents = nav.agents.length > 0
  // India time: the server may run anywhere
  const hour = Number(
    new Intl.DateTimeFormat("en-IN", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: "Asia/Kolkata",
    }).format(new Date())
  )
  const greeting =
    hour < 5
      ? "Working late"
      : hour < 12
        ? "Good morning"
        : hour < 17
          ? "Good afternoon"
          : "Good evening"

  const hrefFor = (thread: (typeof nav.threads)[number]) =>
    thread.agentId
      ? `/a/${thread.agentId}/${thread.id}`
      : `/s/${thread.squadId}/${thread.id}`
  const working = nav.threads.filter((thread) => thread.busy)
  // Threads with something in them; a new agent's empty thread isn't news
  const recent = nav.threads
    .filter((thread) => !thread.busy && thread.preview)
    .slice(0, 5)

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "relative mx-auto flex max-w-3xl flex-col gap-8 px-4 pt-6 pb-10 sm:px-6",
          hasAgents ? "sm:pt-[12vh]" : "sm:pt-14"
        )}
      >
        <header className="rise flex items-center gap-4">
          <span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle,#fbf5ee,#efe3d6)] shadow-[0_12px_30px_-14px_rgb(0_0_0/0.45)] ring-1 ring-black/5 sm:size-16">
            <Mascot priority sizes="80px" className="w-[118%] max-w-none" />
          </span>
          <h1 className="font-display text-[26px] leading-[1.1] font-normal text-balance sm:text-[34px]">
            {hasAgents ? (
              <>
                {greeting}
                {firstName ? `, ${firstName}` : ""}.{" "}
                <em className="text-rigel">What should we get done?</em>
              </>
            ) : (
              <>
                Hi, I&apos;m Tavi. <em className="text-rigel">Pick your first agent.</em>
              </>
            )}
          </h1>
        </header>

        {hasAgents ? (
          <>
            <Ask />

            {working.length > 0 && (
              <section className="flex flex-col gap-2.5">
                <SectionTitle href="/tasks">Working now</SectionTitle>
                <ul className="flex flex-col gap-2">
                  {working.map((thread) => {
                    const agent = nav.agents.find((a) => a.id === thread.agentId)
                    const squad = nav.squads.find((s) => s.id === thread.squadId)
                    return (
                      <li key={thread.id}>
                        <Link
                          href={hrefFor(thread)}
                          className="glass flex min-h-14 items-center gap-3 rounded-2xl border-rigel/30 px-4 py-2.5"
                        >
                          <span className="size-2 shrink-0 animate-pulse-dot rounded-full bg-rigel text-rigel" />
                          <span className="flex min-w-0 flex-1 flex-col leading-tight">
                            <span className="truncate text-[13.5px] font-medium">
                              {thread.title ?? "New thread"}
                            </span>
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {agent?.name ?? squad?.name} is on it
                            </span>
                          </span>
                          <ChevronRightIcon className="size-4 text-faint" />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            <section className="flex flex-col gap-3">
              <SectionTitle href="/agents">Your team</SectionTitle>
              <div className="-mx-4 flex snap-x [scrollbar-width:none] gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
                {nav.agents.map((agent) => (
                  <Link
                    key={agent.id}
                    href={
                      agent.latestThreadId
                        ? `/a/${agent.id}/${agent.latestThreadId}`
                        : `/a/${agent.id}`
                    }
                    className="flex w-[72px] shrink-0 snap-start flex-col items-center gap-1.5 text-center"
                  >
                    <span
                      className={cn(
                        "relative rounded-full p-[3px] ring-2",
                        agent.busy ? "ring-rigel" : "ring-transparent"
                      )}
                    >
                      <Glyph seed={agent.glyph} className="size-14 rounded-full" />
                    </span>
                    <span className="w-full truncate text-[12px] font-medium">
                      {agent.name}
                    </span>
                  </Link>
                ))}
                {nav.squads.map((squad) => (
                  <Link
                    key={squad.id}
                    href={
                      squad.latestThreadId
                        ? `/s/${squad.id}/${squad.latestThreadId}`
                        : `/s/${squad.id}`
                    }
                    className="flex w-[72px] shrink-0 snap-start flex-col items-center gap-1.5 text-center"
                  >
                    <span
                      className={cn(
                        "grid size-[62px] place-items-center rounded-full ring-2",
                        squad.busy ? "ring-rigel" : "ring-transparent"
                      )}
                    >
                      <SquadGlyph seeds={squad.glyphs} className="size-12" />
                    </span>
                    <span className="w-full truncate text-[12px] font-medium">
                      {squad.name}
                    </span>
                  </Link>
                ))}
                <Link
                  href="/agents"
                  className="flex w-[72px] shrink-0 snap-start flex-col items-center gap-1.5 text-center text-muted-foreground"
                >
                  <span className="grid size-[62px] place-items-center rounded-full border border-dashed">
                    <PlusIcon className="size-5" />
                  </span>
                  <span className="text-[12px]">Add</span>
                </Link>
              </div>
            </section>

            {recent.length > 0 && (
              <section className="flex flex-col gap-2.5">
                <SectionTitle>Recent</SectionTitle>
                <div className="glass divide-y overflow-hidden rounded-[20px]">
                  {recent.map((thread) => {
                    const agent = nav.agents.find((a) => a.id === thread.agentId)
                    const squad = nav.squads.find((s) => s.id === thread.squadId)
                    return (
                      <Link
                        key={thread.id}
                        href={hrefFor(thread)}
                        className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                      >
                        {agent ? (
                          <Glyph seed={agent.glyph} className="size-7" />
                        ) : (
                          <SquadGlyph seeds={squad?.glyphs ?? []} className="size-7" />
                        )}
                        <span className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-[13.5px] font-medium">
                            {thread.title ?? "New thread"}
                          </span>
                          <span className="truncate text-[12px] text-muted-foreground">
                            {thread.preview ?? agent?.name ?? squad?.name}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] text-faint">
                          {formatDistanceToNowStrict(new Date(thread.activeAt))}
                        </span>
                      </Link>
                    )
                  })}
                </div>
              </section>
            )}

            <UsageMeter status={status} />
          </>
        ) : (
          <section className="flex flex-col gap-4">
            <p className="text-[14.5px] leading-relaxed text-muted-foreground">
              An agent is an assistant with a role, its own instructions and a memory you
              can see. Start from one of these, or make your own. Agents keep working when
              you close the app.
            </p>
            <TemplateGrid />
            <NewAgentCard />
          </section>
        )}
      </div>
    </div>
  )
}
