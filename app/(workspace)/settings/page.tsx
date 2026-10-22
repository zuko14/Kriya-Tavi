import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ChevronRightIcon } from "lucide-react"

import { StopAllJobs } from "@/components/operator/controls"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { grantLine, STATUS_LABEL } from "@/lib/operator/labels"
import { openJobs } from "@/queries/mandates"

export const metadata: Metadata = { title: "Jobs" }

// Settings became Account: models, keys and machines are Kriya's to run now.
// With jobs on (O3, UX_SPEC §5) this is where every job can be stopped.
export default async function Page() {
  if ((await getSetting("operator.mandates")) !== "on") redirect("/account")
  const user = await requireUser()
  const jobs = await openJobs(user.id)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
            Jobs
          </h1>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            The jobs you handed Kriya and what each may do without asking. Stopping all
            ends every permission at once.
          </p>
        </header>
        <StopAllJobs count={jobs.length} />
        {jobs.length === 0 ? (
          <p className="glass rounded-[20px] px-4 py-6 text-center text-[13.5px] text-muted-foreground">
            No jobs are running.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="glass flex flex-col gap-2 rounded-[20px] px-4 py-4"
              >
                <span className="label-mono text-faint">{STATUS_LABEL[job.status]}</span>
                <h2 className="text-[14.5px] font-medium">{job.title}</h2>
                {job.grants.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    Asks you before every action.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1 text-[13px] break-words text-muted-foreground">
                    {job.grants.map((grant) => (
                      <li key={grant.id}>
                        {grantLine(grant.tool, grant.pins, grant.maxUses)} · used{" "}
                        {grant.uses}
                      </li>
                    ))}
                  </ul>
                )}
                {job.goalId && (
                  <Link
                    href={`/goals/${job.goalId}`}
                    className="flex min-h-11 w-fit items-center gap-1 text-[13px] font-medium text-rigel sm:min-h-0"
                  >
                    Open the job <ChevronRightIcon className="size-3.5" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
