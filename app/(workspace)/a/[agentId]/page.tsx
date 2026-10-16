import { eq } from "drizzle-orm"
import { notFound, redirect } from "next/navigation"

import { StartThread } from "@/components/thread/start-thread"
import { withUser } from "@/db"
import { agents } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getLatestThreadId } from "@/queries/workspace"

export default async function Page({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params
  const user = await requireUser()
  const [agent] = await withUser(user.id, (tx) =>
    tx.select().from(agents).where(eq(agents.id, agentId))
  )
  if (!agent) notFound()

  const latest = await getLatestThreadId(user.id, { agentId })
  if (latest) redirect(`/a/${agentId}/${latest}`)

  return (
    <StartThread
      owner={{ agentId }}
      name={agent.name}
      subtitle={agent.role}
      glyphs={[agent.glyph]}
    />
  )
}
