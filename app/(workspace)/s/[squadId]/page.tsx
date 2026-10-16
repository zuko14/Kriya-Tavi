import { notFound, redirect } from "next/navigation"

import { StartThread } from "@/components/thread/start-thread"
import { requireUser } from "@/lib/auth"
import { getLatestThreadId, getSquads } from "@/queries/workspace"

export default async function Page({ params }: { params: Promise<{ squadId: string }> }) {
  const { squadId } = await params
  const user = await requireUser()
  const squad = (await getSquads(user.id)).find((s) => s.id === squadId)
  if (!squad) notFound()

  const latest = await getLatestThreadId(user.id, { squadId })
  if (latest) redirect(`/s/${squadId}/${latest}`)

  return (
    <StartThread
      owner={{ squadId }}
      name={squad.name}
      subtitle={squad.agents.map((a) => a.name).join(" · ")}
      glyphs={squad.agents.map((a) => a.glyph)}
    />
  )
}
