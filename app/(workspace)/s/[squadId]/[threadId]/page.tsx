import type { Metadata } from "next"

import { ThreadPage } from "@/components/thread/thread-page"
import { requireUser } from "@/lib/auth"
import { getThread } from "@/queries/workspace"

type Params = { params: Promise<{ squadId: string; threadId: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { threadId } = await params
  const user = await requireUser()
  const thread = await getThread(user.id, threadId)
  return {
    title: thread?.squad
      ? `${thread.squad.name} · ${thread.title ?? "New thread"}`
      : "Thread",
  }
}

export default async function Page({ params }: Params) {
  const { squadId, threadId } = await params
  return <ThreadPage threadId={threadId} owner={{ squadId }} />
}
