import { cookies } from "next/headers"
import { notFound } from "next/navigation"

import { CloudStrip } from "@/components/thread/cloud-strip"
import { ThreadView } from "@/components/thread/thread-view"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { agentGlyph } from "@/lib/glyph"
import { getThreadWorkspace } from "@/queries/cloud"
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
    glyph: agentGlyph(agent),
    model: agent.model,
  }))

  const ownerView = isAgent
    ? {
        id: thread.agent!.id,
        name: thread.agent!.name,
        subtitle: thread.agent!.role,
        glyphs: [agentGlyph(thread.agent!)],
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

  // Track C: the thread's cloud workspace, when it has one
  const workspace = await getThreadWorkspace(user.id, thread.id)
  const view = (
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
      filesOn={(await getSetting("agents.files")) === "on"}
    />
  )
  if (!workspace) return view
  return (
    <>
      <CloudStrip workspace={workspace} />
      {view}
    </>
  )
}
