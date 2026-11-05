import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import { LaptopIcon } from "lucide-react"

import { RUN_LABEL } from "@/components/flows/look"
import { NewFlow } from "@/components/flows/new-flow"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { flowsOn } from "@/lib/flows/on"
import { DEVICE_TEMPLATE, TEMPLATES } from "@/lib/flows/templates"
import { agentOptions, listFlows } from "@/queries/flows"

export const metadata: Metadata = { title: "Flows" }

// Track S: what the person has made, and how to make another. Gone with
// studio.flows off.
export default async function Page() {
  const user = await requireUser()
  if (!(await flowsOn())) notFound()
  const [flows, agents, copilot, device] = await Promise.all([
    listFlows(user.id),
    agentOptions(user.id),
    getSetting("studio.copilot"),
    getSetting("studio.deviceFlows"),
  ])
  const onDevice = device === "on"
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
            Flows
          </h1>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Work that runs the same way each time. See every step, check it by rule, and
            stay in charge of anything that matters.
          </p>
        </header>
        <NewFlow
          templates={onDevice ? [...TEMPLATES, DEVICE_TEMPLATE] : TEMPLATES}
          copilot={copilot === "on"}
          device={onDevice}
          agents={agents}
        />
        {flows.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <h2 className="label-mono">Your flows</h2>
            <ul className="flex flex-col gap-2">
              {flows.map((flow) => (
                <li key={flow.id}>
                  <Link
                    href={`/flows/${flow.id}`}
                    className="flex min-h-14 items-center gap-3 rounded-xl border bg-surface/60 px-3 py-2.5 transition-colors hover:border-rigel/40"
                  >
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="flex items-center gap-1.5 truncate text-[14px] font-medium">
                        {flow.target === "device" && (
                          <LaptopIcon
                            className="size-3.5 text-muted-foreground"
                            aria-label="On your computer"
                          />
                        )}
                        {flow.name}
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">
                        {flow.steps} {flow.steps === 1 ? "step" : "steps"}
                        {flow.lastRun
                          ? ` · ${RUN_LABEL[flow.lastRun.status]} ${formatDistanceToNowStrict(flow.lastRun.createdAt, { addSuffix: true })}`
                          : " · Not run yet"}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
