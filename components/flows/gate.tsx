"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { answerGate } from "@/actions/flows"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"

// A flow's gate, wherever the person meets it: the Inbox and the run page.
// Answering is theirs alone (S7).
export function GateButtons({ id, onDone }: { id: string; onDone?: () => void }) {
  const [pending, start] = React.useTransition()
  const reply = (approved: boolean) =>
    start(async () => {
      const result = await answerGate(id, approved)
      if ("error" in result) toast.add({ title: result.error, type: "error" })
      else onDone?.()
    })
  return (
    <div className="flex gap-2">
      <Button
        disabled={pending}
        className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
        onClick={() => reply(true)}
      >
        Approve
      </Button>
      <Button
        variant="outline"
        disabled={pending}
        className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
        onClick={() => reply(false)}
      >
        Decline
      </Button>
    </div>
  )
}

export function FlowGate({
  gate,
}: {
  gate: {
    id: string
    runId: string
    flowId: string
    flowName: string
    title: string
    message: string | null
  }
}) {
  const router = useRouter()
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-surface/60 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          <Link
            href={`/flows/${gate.flowId}/runs/${gate.runId}`}
            className="underline underline-offset-2 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
          >
            {gate.flowName}
          </Link>{" "}
          · {gate.title}
        </span>
        {gate.message && (
          <p className="line-clamp-6 text-[14px] leading-relaxed whitespace-pre-wrap">
            {gate.message}
          </p>
        )}
      </div>
      <GateButtons id={gate.id} onDone={() => router.refresh()} />
    </li>
  )
}
