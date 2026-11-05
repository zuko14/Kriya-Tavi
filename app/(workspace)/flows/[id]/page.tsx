import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { FlowEditor } from "@/components/flows/editor"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { proposeFlow } from "@/lib/flows/improve"
import { flowsOn } from "@/lib/flows/on"
import { flowRowsForEvidence, maxNodeRuns } from "@/lib/flows/store"
import { agentOptions, comparisons, deviceTargets, getFlow } from "@/queries/flows"

export const metadata: Metadata = { title: "Flow" }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!(await flowsOn())) notFound()
  const { id } = await params
  const detail = await getFlow(user.id, id)
  if (!detail) notFound()
  const [agents, limit, copilot, devices, evidence, compared] = await Promise.all([
    agentOptions(user.id),
    maxNodeRuns(),
    getSetting("studio.copilot"),
    deviceTargets(user.id),
    flowRowsForEvidence(user.id, id),
    comparisons(user.id, id),
  ])
  return (
    <FlowEditor
      key={detail.flow.id}
      detail={detail}
      agents={agents}
      limit={limit}
      copilot={copilot === "on"}
      devices={devices}
      moves={proposeFlow(detail.flow.draft, evidence, limit)}
      comparisons={compared}
    />
  )
}
