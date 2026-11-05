"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatDistanceStrict } from "date-fns"
import { ArrowLeftIcon, RotateCcwIcon, SquareIcon } from "lucide-react"

import { cancelRun, rerunFrom, rerunPreview, retryNode } from "@/actions/flows"
import { Confirm } from "@/components/confirm"
import { GateButtons } from "@/components/flows/gate"
import { RUN_LABEL, STATE_LOOK, TYPE_LOOK, type RunState } from "@/components/flows/look"
import { Outline } from "@/components/flows/outline"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { layoutGraph, type Layout } from "@/lib/flows/layout"
import { formatInr } from "@/lib/money"
import { cn } from "@/lib/utils"
import type { RunView as View } from "@/queries/flows"

const FlowCanvas = dynamic(() => import("@/components/flows/canvas"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  ),
})

type Row = View["rows"][number]

const ACTIVE = ["queued", "running", "waiting"]
const POLL_MS = 1_500

const NO = new Set(["fail", "declined", "exhausted"])
const NO_LABEL: Record<string, string> = {
  fail: "Didn't pass",
  declined: "Declined",
  exhausted: "Out of rounds",
}

const stateOf = (row: Row): RunState =>
  row.reused
    ? "reused"
    : row.status === "done" && NO.has(row.port ?? "")
      ? "missed"
      : row.status

const took = (row: Row) =>
  row.finishedAt
    ? formatDistanceStrict(new Date(row.finishedAt), new Date(row.startedAt))
    : undefined

// The latest row of each node across rounds and attempts
function latest(rows: Row[]) {
  const out = new Map<string, Row>()
  for (const row of rows) out.set(row.nodeId, row)
  return out
}

function picture(view: View) {
  const last = latest(view.rows)
  const states: Record<string, { state: RunState; note?: string }> = {}
  for (const [id, row] of last) {
    const node = view.graph.nodes.find((n) => n.id === id)
    states[id] = {
      state: stateOf(row),
      note:
        node?.type === "loop" && row.status === "running"
          ? `Round ${row.iteration} of ${node.config.maxIterations}`
          : NO_LABEL[row.port ?? ""]
            ? NO_LABEL[row.port ?? ""]
            : row.status === "done" && node?.type === "agent"
              ? took(row)
              : undefined,
    }
  }
  const taken = new Set<string>()
  const dead = new Set<string>()
  const live = new Set<string>()
  for (const edge of view.graph.edges) {
    const from = last.get(edge.from)
    const to = last.get(edge.to)
    // Never reached, and it won't be now
    if (!from && !ACTIVE.includes(view.run.status)) dead.add(edge.id)
    if (!from || from.status === "running" || from.status === "waiting") continue
    if (from.port !== edge.port) dead.add(edge.id)
    else if (to?.status === "running") live.add(edge.id)
    else taken.add(edge.id)
  }
  return { states, taken, dead, live }
}

function Money({ value }: { value: string | null }) {
  return value === null ? (
    <span className="text-faint">Not priced</span>
  ) : (
    <>{formatInr(Number(value))}</>
  )
}

function NodePanel({
  view,
  nodeId,
  onChanged,
}: {
  view: View
  nodeId: string
  onChanged: () => void
}) {
  const router = useRouter()
  const node = view.graph.nodes.find((n) => n.id === nodeId)
  const rows = view.rows.filter((r) => r.nodeId === nodeId)
  const row = rows.at(-1)
  const [plan, setPlan] = React.useState<{
    reused: number
    sideEffects: string[]
  } | null>(null)
  if (!node) return null
  const look = TYPE_LOOK[node.type]
  const state = row ? STATE_LOOK[stateOf(row)] : STATE_LOOK.idle
  const StateIcon = state.icon
  const agentId = node.type === "agent" ? node.config.agentId : null
  const canRerun =
    !view.run.device && !ACTIVE.includes(view.run.status) && node.type !== "start"
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-0.5">
        <p className="label-mono">{look.label}</p>
        <h2 className="text-[15px] font-medium">{node.title}</h2>
        <p className={cn("flex items-center gap-1 text-[12.5px]", state.text)}>
          <StateIcon className="size-3.5" aria-hidden />{" "}
          {NO_LABEL[row?.port ?? ""] ?? state.label}
          {row && took(row) && (
            <span className="text-muted-foreground">· {took(row)}</span>
          )}
        </p>
      </div>
      {row?.detail.reason && (
        <p className="rounded-md border border-warn/30 px-2.5 py-1.5 text-[12.5px] leading-snug">
          {row.detail.reason}
        </p>
      )}
      {rows.length > 1 && (
        <p className="text-[11.5px] text-muted-foreground">
          Ran {rows.length} times across rounds and attempts; this is the latest.
        </p>
      )}
      {row?.output && (
        <div className="flex flex-col gap-1">
          <p className="label-mono">
            {node.type === "check" ? "What it judged" : "Result"}
          </p>
          <div className="max-h-72 overflow-y-auto rounded-md border bg-background/40 p-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">
            {row.output}
          </div>
        </div>
      )}
      {row && row.tools.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="label-mono">What it did</p>
          <ul className="flex flex-col gap-1">
            {row.tools.map((tool, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 font-mono text-[11.5px]"
              >
                <span className={cn("truncate", tool.sideEffect && "text-betelgeuse")}>
                  {tool.name}
                </span>
                <span className="shrink-0 text-muted-foreground">{tool.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {row?.detail.tainted && (
        <p className="text-[11.5px] leading-snug text-muted-foreground">
          This step touched your private content, so later steps ask before reaching the
          web.
        </p>
      )}
      {row?.threadId && (
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">
            Cost: <Money value={row.chargeMicroInr} />
          </span>
          {agentId && (
            <Link
              href={`/a/${agentId}/${row.threadId}`}
              className="inline-flex min-h-11 items-center text-rigel underline underline-offset-2 sm:min-h-0"
            >
              Open its thread
            </Link>
          )}
        </div>
      )}
      {row?.status === "failed" &&
        view.run.status === "failed" &&
        node.type === "agent" && (
          <Confirm
            trigger={
              <Button className="min-h-11 sm:min-h-8">
                <RotateCcwIcon /> Retry
              </Button>
            }
            title={
              row.detail.sideEffects?.length ? "Run this again?" : "Retry what failed?"
            }
            description={
              row.detail.sideEffects?.length ? (
                <>
                  <strong>This step already did something real:</strong>{" "}
                  {row.detail.sideEffects.join(", ")}. Running it again could do it twice.
                </>
              ) : (
                "Finished steps stay as they are. Failed steps that did nothing real run again."
              )
            }
            action="Retry"
            onConfirm={async () => {
              const result = await retryNode(view.run.id, row.id)
              if ("error" in result) toast.add({ title: result.error, type: "error" })
              else onChanged()
            }}
          />
        )}
      {canRerun && (
        <Confirm
          trigger={
            <Button
              variant="outline"
              className="min-h-11 sm:min-h-8"
              onClick={async () => {
                const result = await rerunPreview(view.run.id, nodeId)
                setPlan("error" in result ? null : result)
              }}
            >
              Re-run from here
            </Button>
          }
          title="Re-run from this step?"
          description={
            plan ? (
              <>
                {plan.reused} earlier results are reused without running again.
                {plan.sideEffects.length > 0 ? (
                  <>
                    {" "}
                    <strong>These real actions could happen again:</strong>{" "}
                    {plan.sideEffects.join(", ")}.
                  </>
                ) : (
                  " Nothing real ran in the steps that repeat."
                )}
              </>
            ) : (
              "Checking what would repeat…"
            )
          }
          action="Re-run"
          onConfirm={async () => {
            const result = await rerunFrom(view.run.id, nodeId)
            if ("error" in result) toast.add({ title: result.error, type: "error" })
            else router.push(`/flows/${view.flow.id}/runs/${result.runId}`)
          }}
        />
      )}
    </div>
  )
}

export function RunInspector({ initial }: { initial: View }) {
  const [view, setView] = React.useState(initial)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [routes, setRoutes] = React.useState<Layout["routes"]>({})
  const [desktop, setDesktop] = React.useState<boolean | null>(null)
  const active = ACTIVE.includes(view.run.status)
  const id = view.run.id

  const refresh = React.useCallback(async () => {
    const response = await fetch(`/api/flows/runs/${id}`, { cache: "no-store" })
    if (response.ok) setView(await response.json())
  }, [id])

  React.useEffect(() => {
    if (!active) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [active, refresh])

  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)")
    const update = () => setDesktop(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  React.useEffect(() => {
    void layoutGraph(view.graph).then((layout) => {
      const same = view.graph.nodes.every(
        (n) => layout.at[n.id]?.x === n.at.x && layout.at[n.id]?.y === n.at.y
      )
      if (same) setRoutes(layout.routes)
    })
  }, [view.graph])

  // A failure opens on the failed step (journey 5)
  const failed = view.rows.find((r) => r.status === "failed")
  const shown = selected ?? failed?.nodeId ?? null
  const { states, taken, dead, live } = React.useMemo(() => picture(view), [view])
  const gates = view.rows.filter(
    (r) =>
      r.status === "waiting" &&
      view.graph.nodes.find((n) => n.id === r.nodeId)?.type === "approval"
  )
  const inThread = view.rows.filter(
    (r) =>
      r.status === "waiting" &&
      view.graph.nodes.find((n) => n.id === r.nodeId)?.type === "agent"
  )
  const agentName = React.useCallback(
    (id: string) => view.agents.find((a) => a.id === id)?.name ?? "An agent that's gone",
    [view.agents]
  )
  const cost = view.rows.reduce<bigint | null>(
    (sum, r) =>
      r.threadId && !r.reused
        ? sum === null || r.chargeMicroInr === null
          ? null
          : sum + BigInt(r.chargeMicroInr)
        : sum,
    0n
  )
  const tone =
    view.run.status === "completed"
      ? "text-ok"
      : view.run.status === "failed"
        ? "text-destructive"
        : view.run.status === "waiting"
          ? "text-betelgeuse"
          : "text-rigel"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="hairline-b flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <Link
          href={`/flows/${view.flow.id}`}
          aria-label="Back to the flow"
          className="-ml-1 grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-11"
        >
          <ArrowLeftIcon className="size-4" />
        </Link>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate font-display text-[18px]">{view.flow.name}</span>
          <span className="text-[11.5px] text-muted-foreground">
            <span className={cn("font-medium", tone)} aria-live="polite">
              {RUN_LABEL[view.run.status]}
            </span>{" "}
            · Version {view.run.version}
            {view.run.device && " · on your computer"}
            {view.run.forkedFrom && " · re-run"}
            {" · "}
            {cost === null
              ? "Cost not priced"
              : cost === 0n
                ? "No cost yet"
                : formatInr(Number(cost))}
          </span>
        </span>
        {active && (
          <Button
            variant="outline"
            className="min-h-11 md:min-h-8"
            onClick={async () => {
              const result = await cancelRun(id)
              if ("error" in result) toast.add({ title: result.error, type: "error" })
              else void refresh()
            }}
          >
            <SquareIcon /> Stop
          </Button>
        )}
      </header>

      {(gates.length > 0 || inThread.length > 0 || view.run.error) && (
        <div className="flex flex-col gap-2 border-b bg-surface/60 p-3">
          {view.run.error && (
            <p className="text-[13px] text-destructive">{view.run.error}</p>
          )}
          {gates.map((gate) => (
            <div key={gate.id} className="flex flex-col gap-2">
              <p className="text-[13px] font-medium">
                {view.graph.nodes.find((n) => n.id === gate.nodeId)?.title}
              </p>
              {gate.output && (
                <p className="line-clamp-6 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {gate.output}
                </p>
              )}
              <GateButtons id={gate.id} onDone={() => void refresh()} />
            </div>
          ))}
          {inThread.map((row) => {
            const node = view.graph.nodes.find((n) => n.id === row.nodeId)
            return node?.type === "agent" && row.threadId ? (
              <p key={row.id} className="text-[13px]">
                {node.title} needs your approval.{" "}
                <Link
                  className="inline-flex min-h-11 items-center text-rigel underline underline-offset-2 sm:min-h-0"
                  href={`/a/${node.config.agentId}/${row.threadId}`}
                >
                  Open it
                </Link>
              </p>
            ) : null
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 max-md:flex-col max-md:overflow-y-auto">
        {desktop === false ? (
          <div className="flex flex-col gap-4 p-4">
            {view.run.output && (
              <section className="flex flex-col gap-1">
                <h2 className="label-mono">Result</h2>
                <div className="rounded-md border bg-surface p-3 text-[13.5px] leading-relaxed whitespace-pre-wrap">
                  {view.run.output}
                </div>
              </section>
            )}
            <Outline
              graph={view.graph}
              states={states}
              selected={shown}
              onSelect={setSelected}
              agentName={agentName}
            />
            {shown && (
              <div className="rounded-lg border bg-surface">
                <NodePanel view={view} nodeId={shown} onChanged={() => void refresh()} />
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="relative min-w-0 flex-1">
              {desktop && (
                <FlowCanvas
                  graph={view.graph}
                  agentName={agentName}
                  routes={routes}
                  reading
                  states={states}
                  taken={taken}
                  dead={dead}
                  live={live}
                  selected={shown}
                  onSelect={setSelected}
                />
              )}
            </div>
            <aside
              className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l"
              aria-label="Step detail"
            >
              {shown ? (
                <NodePanel view={view} nodeId={shown} onChanged={() => void refresh()} />
              ) : (
                <div className="flex flex-col gap-3 p-4">
                  {view.run.output ? (
                    <>
                      <p className="label-mono">Result</p>
                      <div className="rounded-md border bg-background/40 p-3 text-[13px] leading-relaxed whitespace-pre-wrap">
                        {view.run.output}
                      </div>
                    </>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">
                      Select a step to see what happened in it.
                    </p>
                  )}
                </div>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  )
}
