import { cookies } from "next/headers"
import { notFound } from "next/navigation"

import { ThreadView } from "@/components/thread/thread-view"
import { requireUser } from "@/lib/auth"
import { getThread, getThreadsFor } from "@/queries/workspace"

// Shared by the agent and squad thread routes
export async function ThreadPage({
  threadId,
  owner,
}: {
  threadId: string
  owner: { agentId: string } | { squadId: string }
}) {
  const user = await requireUser()
  const thread = await getThread(user.id, threadId)
  if (!thread) notFound()

  const isAgent = "agentId" in owner
  if (isAgent ? thread.agentId !== owner.agentId : thread.squadId !== owner.squadId)
    notFound()

  const members = thread.members.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    glyph: agent.glyph,
    model: agent.model,
  }))

  const ownerView = isAgent
    ? {
        id: thread.agent!.id,
        name: thread.agent!.name,
        subtitle: thread.agent!.role,
        glyphs: [thread.agent!.glyph],
      }
    : {
        id: thread.squad!.id,
        name: thread.squad!.name,
        subtitle: members.map((m) => m.name).join(" · "),
        glyphs: members.map((m) => m.glyph),
      }

  const threads = (
    await getThreadsFor(
      user.id,
      isAgent ? { agentId: owner.agentId } : { squadId: owner.squadId }
    )
  ).map((t) => ({ id: t.id, title: t.title, activeAt: t.activeAt.toISOString() }))

  return (
    <ThreadView
      key={thread.id}
      threadId={thread.id}
      title={thread.title}
      kind={isAgent ? "agent" : "squad"}
      owner={ownerView}
      members={members}
      threads={threads}
      initialMessages={thread.messages}
      workbenchOpen={(await cookies()).get("kriya_panel")?.value !== "closed"}
    />
  )
}
