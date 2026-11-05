"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { ArrowRightIcon, SparklesIcon } from "lucide-react"

import { createFlow, designFlow } from "@/actions/flows"
import { Outline } from "@/components/flows/outline"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import type { FlowGraph, Target } from "@/lib/flows/graph"
import type { Template } from "@/lib/flows/templates"
import { layoutGraph, withLayout } from "@/lib/flows/layout"

const FlowCanvas = dynamic(() => import("@/components/flows/canvas"), { ssr: false })

type Design = { name: string; why: string; graph: FlowGraph }

// Start from words, from a starting point, or from nothing (journey 1). A
// description is only ever a preview until the person keeps it.
export function NewFlow({
  templates,
  copilot,
  device,
  agents,
}: {
  templates: Template[]
  copilot: boolean
  device: boolean
  agents: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [text, setText] = React.useState("")
  const [target, setTarget] = React.useState<Target>("cloud")
  const [design, setDesign] = React.useState<Design | null>(null)
  const [pending, start] = React.useTransition()
  const agentName = React.useCallback(
    (id: string) => agents.find((a) => a.id === id)?.name ?? "",
    [agents]
  )
  const make = (input: object) =>
    start(async () => {
      const result = await createFlow(input)
      if ("error" in result) toast.add({ title: result.error, type: "error" })
      else router.push(`/flows/${result.id}`)
    })

  if (design)
    return (
      <section className="flex flex-col gap-3 rounded-2xl border bg-surface/60 p-4">
        <div className="flex flex-col gap-1">
          <p className="label-mono">A proposal, not saved</p>
          <h2 className="font-display text-[22px] leading-tight">{design.name}</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {design.why}
          </p>
        </div>
        <div className="hidden h-[26rem] overflow-hidden rounded-xl border md:block">
          <FlowCanvas graph={design.graph} agentName={agentName} reading fitMin={0.3} />
        </div>
        <div className="md:hidden">
          <Outline graph={design.graph} agentName={agentName} />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            className="min-h-11 sm:min-h-8"
            onClick={() => setDesign(null)}
          >
            Discard
          </Button>
          <Button
            className="min-h-11 sm:min-h-8"
            disabled={pending}
            onClick={() => make({ name: design.name, graph: design.graph })}
          >
            {pending ? <Spinner /> : "Use this"}
          </Button>
        </div>
      </section>
    )

  return (
    <div className="flex flex-col gap-6">
      {copilot && (
        <form
          className="glass flex flex-col gap-2.5 rounded-2xl p-3"
          onSubmit={(e) => {
            e.preventDefault()
            start(async () => {
              const result = await designFlow({ request: text, target })
              if ("error" in result) {
                toast.add({ title: result.error, type: "error" })
                return
              }
              const layout = await layoutGraph(result.graph)
              setDesign({ ...result, graph: withLayout(result.graph, layout) })
            })
          }}
        >
          <label
            htmlFor="flow-describe"
            className="flex items-center gap-1.5 px-1 text-[13px] font-medium"
          >
            <SparklesIcon className="size-4 text-rigel" /> Describe what you want done
          </label>
          <Textarea
            id="flow-describe"
            rows={3}
            maxLength={2000}
            className="border-0 bg-transparent focus-visible:ring-0 dark:bg-transparent"
            placeholder="Every invoice over ₹50,000 gets a polite reminder, and I check each one before it goes"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            {device ? (
              <select
                aria-label="Where it runs"
                value={target}
                onChange={(e) => setTarget(e.target.value as Target)}
                className="h-9 rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none max-sm:h-11 dark:bg-input/30"
              >
                <option value="cloud">In Kriya</option>
                <option value="device">On my computer</option>
              </select>
            ) : (
              <span />
            )}
            <Button
              type="submit"
              disabled={pending || text.trim().length < 8}
              className="min-h-11 sm:min-h-8"
            >
              {pending ? <Spinner /> : "Show me"}
            </Button>
          </div>
        </form>
      )}
      <section className="flex flex-col gap-2.5">
        <h2 className="label-mono">Starting points</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {templates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                disabled={pending}
                onClick={() => make({ name: t.name, template: t.id })}
                className="group flex h-full min-h-16 w-full flex-col gap-1 rounded-xl border bg-surface/60 p-3 text-left transition-colors hover:border-rigel/40"
              >
                <span className="flex items-center gap-1 text-[13.5px] font-medium">
                  {t.name}
                  <ArrowRightIcon className="size-3.5 text-faint transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="text-[12.5px] leading-snug text-muted-foreground">
                  {t.blurb}
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              disabled={pending}
              onClick={() => make({ name: "New flow" })}
              className="flex h-full min-h-16 w-full flex-col gap-1 rounded-xl border border-dashed p-3 text-left transition-colors hover:border-rigel/40"
            >
              <span className="text-[13.5px] font-medium">Start empty</span>
              <span className="text-[12.5px] leading-snug text-muted-foreground">
                Draw it yourself.
              </span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  )
}
