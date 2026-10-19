import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronRightIcon } from "lucide-react"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { getGoals } from "@/queries/goals"

export const metadata: Metadata = { title: "Goals" }

// The person's goals (A3). Agents start them with goal_create in a chat;
// each has its own page and thread.
export default async function Page() {
  const user = await requireUser()
  if ((await getSetting("agents.goals")) !== "on") notFound()
  const goals = await getGoals(user.id)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
            Goals
          </h1>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            What you&apos;re working towards with your agents. Ask one in a chat to start
            a goal, and it gets its own thread and checklist.
          </p>
        </header>
        {goals.length === 0 ? (
          <p className="glass rounded-[20px] px-4 py-6 text-center text-[13.5px] text-muted-foreground">
            No goals yet.
          </p>
        ) : (
          <ul className="glass divide-y overflow-hidden rounded-[20px]">
            {goals.map((goal) => {
              const done = goal.plan.filter((item) => item.status === "done").length
              return (
                <li key={goal.id}>
                  <Link
                    href={`/goals/${goal.id}`}
                    className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-accent/40"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[14px] font-medium">
                        {goal.title}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {goal.status} · {done} of {goal.plan.length} done
                      </span>
                    </span>
                    <ChevronRightIcon className="size-4 text-faint" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
