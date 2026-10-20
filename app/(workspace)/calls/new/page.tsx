import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeftIcon } from "lucide-react"

import { NewCall } from "@/components/voice/new-call"
import { requireUser } from "@/lib/auth"
import { voiceAvailable } from "@/lib/voice/tasks"

export const metadata: Metadata = { title: "New call" }

// Speak or type a request (UX_AND_INTERACTION_SPEC §2)
export default async function Page() {
  const user = await requireUser()
  if (!(await voiceAvailable(user.id))) notFound()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <Link
          href="/calls"
          className="flex min-h-11 w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          Calls
        </Link>
        <h1 className="font-display text-[28px] leading-none font-normal sm:text-[34px]">
          Who should I call?
        </h1>
        <NewCall />
      </div>
    </div>
  )
}
