import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { ReviewRoom } from "@/components/editing/review-room"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { editRoom } from "@/queries/editing"

export const metadata: Metadata = { title: "Review" }

// Track E, ED15: one cut, as its owner (RLS: another person's id finds nothing).
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (
    (await getSetting("editing.tavi")) !== "on" ||
    (await getSetting("editing.review")) !== "on"
  )
    notFound()
  const id = z.uuid().safeParse((await params).id)
  const room = id.success ? await editRoom(user.id, id.data) : null
  if (!room) notFound()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ReviewRoom job={room.job} cuts={room.cuts} notes={room.notes} />
    </div>
  )
}
