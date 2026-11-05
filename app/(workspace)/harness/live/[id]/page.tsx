import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { LiveView } from "@/components/harness/live"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { liveFeed } from "@/lib/harness/live"

export const metadata: Metadata = { title: "Remote Control" }

export default async function LivePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const id = z.uuid().safeParse((await params).id)
  if (
    !id.success ||
    (await getSetting("harness.api")) !== "on" ||
    (await getSetting("harness.remoteControl")) !== "on"
  )
    notFound()
  const feed = await liveFeed(user.id, id.data, -1)
  if (!feed) notFound()
  return <LiveView initial={feed} />
}
