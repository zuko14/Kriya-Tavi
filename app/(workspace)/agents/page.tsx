import type { Metadata } from "next"
import Link from "next/link"

import { Glyph, SquadGlyph } from "@/components/glyph"
import {
  EditButton,
  NewAgentCard,
  NewSquadButton,
  TemplateGrid,
} from "@/components/home/actions"
import { requireUser } from "@/lib/auth"
import { TIER_LABELS, isTier } from "@/lib/tiers"
import { getNavigation, getSystemStatus } from "@/queries/workspace"

export const metadata: Metadata = { title: "Agents" }

function SectionTitle({
  children,
  aside,
}: {
  children: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="font-display text-[22px] leading-none font-normal">{children}</h2>
      <span className="h-px flex-1 bg-hairline" />
      {aside}
    </div>
  )
}

export default async function Page() {
  const user = await requireUser()
  const [nav, status] = await Promise.all([getNavigation(user.id), getSystemStatus(user)])
  const atLimit = nav.agents.length >= status.plan.maxAgents

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
            Your team
          </h1>
          <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground">
            Each agent has its own role, instructions and memory. Put two or more in a
            squad and the lead splits a request between them so they work at the same
            time.
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <SectionTitle
            aside={
              <span className="font-mono text-[10.5px] text-faint tabular-nums">
                {nav.agents.length}/{status.plan.maxAgents}
              </span>
            }
          >
            Agents
          </SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {nav.agents.map((agent) => (
              <div key={agent.id} className="relative min-w-0">
                <Link
                  href={
                    agent.latestThreadId
                      ? `/a/${agent.id}/${agent.latestThreadId}`
                      : `/a/${agent.id}`
                  }
                  className="glass flex min-h-[132px] flex-col gap-3 rounded-[20px] p-4 pr-14 transition-all duration-300 hover:-translate-y-0.5 hover:border-input"
                >
                  <div className="flex items-center gap-3">
                    <Glyph seed={agent.glyph} className="size-11" />
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-[15px] font-semibold">
                        {agent.name}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {agent.role}
                      </span>
                    </div>
                  </div>
                  <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                    {agent.instructions}
                  </p>
                  <div className="mt-auto flex items-center gap-2 font-mono text-[10.5px] text-faint">
                    {agent.busy ? (
                      <span className="flex items-center gap-1.5 text-rigel">
                        <span className="size-1.5 animate-pulse-dot rounded-full bg-rigel text-rigel" />
                        working
                      </span>
                    ) : (
                      <span>
                        {TIER_LABELS[isTier(agent.model) ? agent.model : "budget"].name}{" "}
                        model
                      </span>
                    )}
                  </div>
                </Link>
                <EditButton agent={agent} />
              </div>
            ))}
            {!atLimit && <NewAgentCard />}
          </div>
          {atLimit && (
            <p className="font-mono text-[11px] text-faint">
              Your {status.plan.name} plan allows {status.plan.maxAgents} agents.{" "}
              <Link href="/account#plan" className="text-rigel hover:underline">
                See plans
              </Link>
            </p>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <SectionTitle aside={<NewSquadButton disabled={nav.agents.length < 2} />}>
            Squads
          </SectionTitle>
          {nav.squads.length === 0 ? (
            <p className="glass rounded-[20px] p-5 text-[13.5px] leading-relaxed text-muted-foreground">
              {nav.agents.length < 2
                ? "Create a second agent to form a squad."
                : "A squad is a lead agent with sub-agents in one thread. The lead splits your request, the sub-agents work on their parts at the same time, and the lead puts it together into one answer."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {nav.squads.map((squad) => (
                <div key={squad.id} className="relative min-w-0">
                  <Link
                    href={
                      squad.latestThreadId
                        ? `/s/${squad.id}/${squad.latestThreadId}`
                        : `/s/${squad.id}`
                    }
                    className="glass flex min-h-[76px] items-center gap-3 rounded-[20px] p-4 pr-14 transition-all duration-300 hover:-translate-y-0.5 hover:border-input"
                  >
                    <SquadGlyph seeds={squad.glyphs} className="size-11" />
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-[14.5px] font-semibold">
                        {squad.name}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {squad.busy
                          ? "working"
                          : `lead + ${squad.agentIds.length - 1} sub-agent${squad.agentIds.length === 2 ? "" : "s"}`}
                      </span>
                    </div>
                  </Link>
                  <EditButton squad={squad} />
                </div>
              ))}
            </div>
          )}
        </section>

        {!atLimit && (
          <section className="flex flex-col gap-4">
            <SectionTitle>Start from a template</SectionTitle>
            <TemplateGrid />
          </section>
        )}
      </div>
    </div>
  )
}
