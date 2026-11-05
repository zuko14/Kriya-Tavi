import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { RunInspector } from "@/components/flows/run-view"
import { requireUser } from "@/lib/auth"
import { flowsOn } from "@/lib/flows/on"
import { getRun } from "@/queries/flows"

export const metadata: Metadata = { title: "Run" }

// A run, live or finished. Someone else's id is a 404 (RLS).
export default async function Page({
  params,
}: {
  params: Promise<{ id: string; runId: string }>
}) {
  const user = await requireUser()
  if (!(await flowsOn())) notFound()
  const { id, runId } = await params
  const view = await getRun(user.id, runId)
  if (!view || view.flow.id !== id) notFound()
  return <RunInspector initial={JSON.parse(JSON.stringify(view))} />
}
