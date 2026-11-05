"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import type { Connection } from "@xyflow/react"
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CloudOffIcon,
  PlayIcon,
  Redo2Icon,
  SparklesIcon,
  Undo2Icon,
} from "lucide-react"

import {
  archiveFlow,
  designFlow,
  restoreVersion,
  saveCases,
  saveDraft,
  saveVersion,
  startComparison,
  startRun,
} from "@/actions/flows"
import { Confirm } from "@/components/confirm"
import { RUN_LABEL, SOURCE_LABEL, TYPE_LOOK } from "@/components/flows/look"
import { Inspector } from "@/components/flows/inspector"
import { Outline } from "@/components/flows/outline"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { compile, diffGraphs, type GraphDiff } from "@/lib/flows/compile"
import { PORTS, type FlowGraph, type FlowNode, type NodeType } from "@/lib/flows/graph"
import type { Move } from "@/lib/flows/improve"
import {
  freeSpot,
  layoutGraph,
  NODE_H,
  REGION_PAD,
  REGION_TOP,
  unplaced,
  withLayout,
  type Layout,
} from "@/lib/flows/layout"
import { cn } from "@/lib/utils"
import type { AgentOption, ComparisonView, FlowDetail } from "@/queries/flows"

const FlowCanvas = dynamic(() => import("@/components/flows/canvas"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  ),
})

type Device = {
  id: string
  name: string
  polledAt: Date | null
  projects: unknown
}

type Tab = "build" | "runs" | "versions" | "improve"
const TABS: { id: Tab; label: string }[] = [
  { id: "build", label: "Build" },
  { id: "runs", label: "Runs" },
  { id: "versions", label: "Versions" },
  { id: "improve", label: "Improve" },
]

type Proposal = {
  graph: FlowGraph
  title: string
  why: string
  source: "copilot" | "improve"
}

function useDesktop() {
  const [desktop, setDesktop] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)")
    const update = () => setDesktop(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return desktop
}

const nextId = (graph: FlowGraph, type: NodeType) => {
  for (let n = 1; ; n++) {
    const id = `${type}_${n}`
    if (!graph.nodes.some((x) => x.id === id)) return id
  }
}

function blank(
  graph: FlowGraph,
  type: NodeType,
  agents: AgentOption[],
  at: FlowNode["at"],
  parent?: string
): FlowNode {
  const id = nextId(graph, type)
  const base = { id, title: TYPE_LOOK[type].label, at, ...(parent && { parent }) }
  switch (type) {
    case "agent":
      return {
        ...base,
        type,
        config: { agentId: agents[0]?.id ?? "", prompt: "", retries: 0 },
      }
    case "check":
      return {
        ...base,
        type,
        config: { subject: "", rule: { kind: "min_chars", n: 40 } },
      }
    case "approval":
      return { ...base, type, config: { message: "", expiresHours: 72 } }
    case "merge":
      return { ...base, type, config: {} }
    case "loop":
      return { ...base, type, config: { maxIterations: 3, until: "" } }
    case "step":
      return { ...base, type, title: "Step", config: { doneWhen: "", files: [] } }
    case "end":
      return { ...base, type, config: { result: "" } }
    case "start":
      return { ...base, type, config: {} }
  }
}

const describeDiff = (d: GraphDiff) => {
  const parts = [
    d.added.length && `${d.added.length} added`,
    d.removed.length && `${d.removed.length} removed`,
    d.changed.length && `${d.changed.length} changed`,
    (d.edgesAdded.length || d.edgesRemoved.length) &&
      `${d.edgesAdded.length + d.edgesRemoved.length} connections`,
    d.settings.length && d.settings.join(", "),
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : "Only the layout"
}

export function FlowEditor({
  detail,
  agents,
  limit,
  copilot,
  devices,
  moves,
  comparisons,
}: {
  detail: FlowDetail
  agents: AgentOption[]
  limit: number
  copilot: boolean
  devices: Device[]
  moves: Move[]
  comparisons: ComparisonView[]
}) {
  const { flow, versions, runs } = detail
  const router = useRouter()
  const desktop = useDesktop()
  const [tab, setTab] = React.useState<Tab>("build")
  const [graph, setGraph] = React.useState(flow.draft)
  const [name, setName] = React.useState(flow.name)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [routes, setRoutes] = React.useState<Layout["routes"]>({})
  const [saving, setSaving] = React.useState<"saved" | "saving" | "error">("saved")
  const [proposal, setProposal] = React.useState<Proposal | null>(null)
  const [runOpen, setRunOpen] = React.useState(false)
  const history = React.useRef({ past: [] as FlowGraph[], future: [] as FlowGraph[] })
  const rev = React.useRef(flow.draftRev)
  const dirty = React.useRef<{ graph: FlowGraph; name: string } | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const inFlight = React.useRef(false)
  const source = React.useRef<"person" | "copilot" | "improve">("person")
  // Automatic tidying stops once the person places something by hand
  const placedByHand = React.useRef(false)

  const compiled = React.useMemo(
    () => compile(graph, { maxAgentRuns: limit }),
    [graph, limit]
  )
  const errors = compiled.issues.filter((i) => i.severity === "error")
  const agentName = React.useCallback(
    (id: string) => agents.find((a) => a.id === id)?.name ?? "Choose an agent",
    [agents]
  )

  const flush = React.useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    while (dirty.current) {
      const next = dirty.current
      dirty.current = null
      setSaving("saving")
      const result = await saveDraft(flow.id, {
        graph: next.graph,
        rev: rev.current,
        name: next.name,
      })
      if ("error" in result) {
        inFlight.current = false
        setSaving("error")
        toast.add({ title: result.error, type: "error" })
        return
      }
      rev.current = result.rev
    }
    inFlight.current = false
    setSaving("saved")
  }, [flow.id])

  const queueSave = React.useCallback(
    (next: FlowGraph, title: string) => {
      dirty.current = { graph: next, name: title }
      setSaving("saving")
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), 700)
    },
    [flush]
  )

  const commit = React.useCallback(
    (next: FlowGraph) => {
      setGraph((now) => {
        history.current.past = [...history.current.past.slice(-49), now]
        history.current.future = []
        return next
      })
      queueSave(next, name)
    },
    [name, queueSave]
  )

  const placeAll = React.useCallback(
    (target: FlowGraph, layout: Layout, keep: boolean) => {
      setRoutes(layout.routes)
      const placed = withLayout(target, layout)
      if (keep) {
        setGraph(placed)
        queueSave(placed, name)
      } else commit(placed)
      placedByHand.current = false
    },
    [commit, name, queueSave]
  )

  const relayout = React.useCallback(
    async (target: FlowGraph) => placeAll(target, await layoutGraph(target), false),
    [placeAll]
  )

  // A template or a design arrives unplaced; a tidied flow gets its routes back
  React.useEffect(() => {
    void layoutGraph(flow.draft).then((layout) => {
      if (unplaced(flow.draft)) return placeAll(flow.draft, layout, true)
      const same = flow.draft.nodes.every(
        (n) => layout.at[n.id]?.x === n.at.x && layout.at[n.id]?.y === n.at.y
      )
      if (same) setRoutes(layout.routes)
      else placedByHand.current = true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const structural = (next: FlowGraph) => {
    if (placedByHand.current) {
      setRoutes({})
      commit(next)
    } else void relayout(next)
  }

  const add = (type: NodeType) => {
    const sel = graph.nodes.find((n) => n.id === selected)
    const parent = sel?.type === "loop" ? sel.id : sel?.parent
    const at =
      sel?.type === "loop"
        ? { x: REGION_PAD, y: REGION_TOP }
        : sel
          ? { x: sel.at.x, y: sel.at.y + NODE_H + 64 }
          : { x: 160, y: 160 }
    const node = blank(graph, type, agents, freeSpot(graph, at, parent), parent)
    const nodes: FlowNode[] = [...graph.nodes, node]
    let edges = graph.edges
    if (sel && sel.type !== "loop" && sel.type !== "end") {
      // After the selected step: into its first way out, before whatever followed
      const port = PORTS[sel.type][0]
      const old = edges.find((e) => e.from === sel.id && e.port === port)
      const firstOut = PORTS[type][0]
      edges = edges.filter((e) => e !== old)
      edges = [
        ...edges,
        { id: `${sel.id}:${port}:${node.id}`, from: sel.id, port, to: node.id },
      ]
      if (old && firstOut)
        edges = [
          ...edges,
          {
            id: `${node.id}:${firstOut}:${old.to}`,
            from: node.id,
            port: firstOut,
            to: old.to,
          },
        ]
    }
    let next: FlowGraph = { ...graph, nodes, edges }
    if (type === "loop") {
      // A loop is only valid with a check to end it, so it comes with one
      const check = blank(
        next,
        "check",
        agents,
        { x: REGION_PAD, y: REGION_TOP },
        node.id
      )
      next = {
        ...next,
        nodes: [
          ...next.nodes.map((n) =>
            n.id === node.id && n.type === "loop"
              ? { ...n, config: { ...n.config, until: check.id } }
              : n
          ),
          check,
        ],
      }
    }
    structural(next)
    setSelected(node.id)
  }

  const remove = React.useCallback(
    (nodes: string[], edges: string[]) => {
      const gone = new Set(nodes)
      for (const n of graph.nodes) if (n.parent && gone.has(n.parent)) gone.add(n.id)
      for (const n of graph.nodes) if (n.parent && gone.has(n.parent)) gone.add(n.id)
      const safe = new Set(
        [...gone].filter((id) => graph.nodes.find((n) => n.id === id)?.type !== "start")
      )
      structural({
        ...graph,
        nodes: graph.nodes.filter((n) => !safe.has(n.id)),
        edges: graph.edges.filter(
          (e) => !safe.has(e.from) && !safe.has(e.to) && !edges.includes(e.id)
        ),
      })
      setSelected(null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph]
  )

  const connect = React.useCallback(
    (c: Connection) => {
      if (!c.sourceHandle || !c.source || !c.target) return
      const id = `${c.source}:${c.sourceHandle}:${c.target}`
      if (graph.edges.some((e) => e.id === id)) return
      // One way out leads to one place; a new connection replaces the old
      structural({
        ...graph,
        edges: [
          ...graph.edges.filter(
            (e) => !(e.from === c.source && e.port === c.sourceHandle)
          ),
          { id, from: c.source, port: c.sourceHandle, to: c.target },
        ],
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph]
  )

  const move = React.useCallback(
    (id: string, at: FlowNode["at"]) => {
      placedByHand.current = true
      setRoutes((now) =>
        Object.fromEntries(
          Object.entries(now).filter(([key]) => {
            const edge = graph.edges.find((e) => e.id === key)
            return edge && edge.from !== id && edge.to !== id
          })
        )
      )
      commit({
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === id ? { ...n, at } : n)),
      })
    },
    [commit, graph]
  )

  const undo = React.useCallback(() => {
    const last = history.current.past.at(-1)
    if (!last) return
    setGraph((now) => {
      history.current.past = history.current.past.slice(0, -1)
      history.current.future = [now, ...history.current.future]
      return last
    })
    setRoutes({})
    queueSave(last, name)
  }, [name, queueSave])

  const redo = React.useCallback(() => {
    const next = history.current.future[0]
    if (!next) return
    setGraph((now) => {
      history.current.past = [...history.current.past, now]
      history.current.future = history.current.future.slice(1)
      return next
    })
    setRoutes({})
    queueSave(next, name)
  }, [name, queueSave])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo])

  const preview = React.useCallback(async (p: Proposal) => {
    const layout = await layoutGraph(p.graph)
    setProposal({ ...p, graph: withLayout(p.graph, layout) })
    setRoutes(layout.routes)
    setTab("build")
  }, [])

  const apply = () => {
    if (!proposal) return
    source.current = proposal.source
    commit(proposal.graph)
    placedByHand.current = false
    setProposal(null)
  }

  const shown = proposal?.graph ?? graph
  const diff = React.useMemo(
    () => (proposal ? diffGraphs(graph, proposal.graph) : null),
    [graph, proposal]
  )
  const added = React.useMemo(
    () => new Set([...(diff?.added ?? []), ...(diff?.edgesAdded ?? [])]),
    [diff]
  )
  const changed = React.useMemo(() => new Set(diff?.changed.map((c) => c.id)), [diff])

  const palette: NodeType[] =
    graph.target === "device"
      ? ["step"]
      : ["agent", "check", "approval", "merge", "loop", "end"]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="hairline-b flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <Link
          href="/flows"
          aria-label="All flows"
          className="-ml-1 grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-11"
        >
          <ArrowLeftIcon className="size-4" />
        </Link>
        <input
          aria-label="Flow name"
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value)
            if (e.target.value.trim()) queueSave(graph, e.target.value)
          }}
          className="min-h-11 min-w-0 flex-1 bg-transparent font-display text-[20px] outline-none sm:max-w-sm md:min-h-8"
        />
        <span
          className="flex items-center gap-1 text-[11.5px] text-muted-foreground"
          aria-live="polite"
        >
          {saving === "saving" && "Saving…"}
          {saving === "saved" && (
            <>
              <CheckIcon className="size-3.5" /> Saved
            </>
          )}
          {saving === "error" && (
            <span className="flex items-center gap-1 text-destructive">
              <CloudOffIcon className="size-3.5" /> Not saved
            </span>
          )}
        </span>
        <nav
          aria-label="Flow sections"
          className="order-last flex w-full gap-1 md:order-none md:ml-auto md:w-auto"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
              className={cn(
                "min-h-11 flex-1 rounded-md px-3 text-[13px] transition-colors md:min-h-8 md:flex-none",
                tab === t.id
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:bg-accent/60"
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <Button
          className="min-h-11 md:min-h-8"
          disabled={errors.length > 0 || Boolean(proposal)}
          title={errors[0]?.message}
          onClick={() => setRunOpen(true)}
        >
          <PlayIcon /> Run
        </Button>
      </header>

      {tab === "build" && (
        <div className="flex min-h-0 flex-1">
          {desktop === false ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <Outline graph={shown} agentName={agentName} />
              {errors.length > 0 && (
                <p className="mt-3 text-[12.5px] text-destructive">{errors[0].message}</p>
              )}
              <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground">
                To change the steps, open this flow on a larger screen, or describe the
                change.
              </p>
              {copilot && <Describe graph={graph} onProposal={preview} />}
            </div>
          ) : (
            <>
              <div
                className="flex w-12 shrink-0 flex-col items-center gap-1 border-r py-3"
                aria-label="Add a step"
              >
                {palette.map((type) => {
                  const look = TYPE_LOOK[type]
                  const Icon = look.icon
                  return (
                    <button
                      key={type}
                      type="button"
                      title={`Add ${look.label.toLowerCase()}`}
                      aria-label={`Add ${look.label.toLowerCase()}`}
                      disabled={Boolean(proposal)}
                      onClick={() => add(type)}
                      className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                    >
                      <Icon className="size-4" />
                    </button>
                  )
                })}
                <span className="my-1 h-px w-6 bg-border" />
                <button
                  type="button"
                  aria-label="Undo"
                  title="Undo"
                  onClick={undo}
                  className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Undo2Icon className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Redo"
                  title="Redo"
                  onClick={redo}
                  className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Redo2Icon className="size-4" />
                </button>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                {proposal && diff && (
                  <div className="hairline-b flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface px-4 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="label-mono">
                        {proposal.source === "copilot"
                          ? "A proposal, not saved"
                          : "An improvement, not saved"}
                      </p>
                      <p className="text-[13px] font-medium">{proposal.title}</p>
                      <p className="text-[12px] leading-snug text-muted-foreground">
                        {proposal.why}
                      </p>
                      <p className="font-mono text-[11px] text-faint">
                        {describeDiff(diff)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="ghost" onClick={() => setProposal(null)}>
                        Discard
                      </Button>
                      <Button onClick={apply}>Use this</Button>
                    </div>
                  </div>
                )}
                <div className="relative min-h-0 flex-1">
                  {desktop && (
                    <FlowCanvas
                      graph={shown}
                      agentName={agentName}
                      issues={proposal ? [] : compiled.issues}
                      routes={routes}
                      reading={Boolean(proposal)}
                      added={added}
                      changed={changed}
                      selected={selected}
                      onSelect={setSelected}
                      onMove={move}
                      onConnect={connect}
                      onDelete={remove}
                      onTidy={() => void relayout(graph)}
                    />
                  )}
                </div>
              </div>
              <div className="flex w-[340px] shrink-0 flex-col border-l max-lg:w-[300px]">
                <Inspector
                  className="flex-1"
                  graph={graph}
                  plan={compiled.plan}
                  bound={compiled.bound}
                  issues={compiled.issues}
                  agents={agents}
                  selected={selected}
                  onChange={commit}
                  onSelect={setSelected}
                  onRemove={(id) => remove([id], [])}
                />
                {copilot && !proposal && (
                  <div className="border-t p-3">
                    <Describe graph={graph} onProposal={preview} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {tab === "runs" && <Runs flowId={flow.id} runs={runs} />}
      {tab === "versions" && (
        <Versions
          flowId={flow.id}
          versions={versions}
          draft={graph}
          sourceRef={source}
          flush={flush}
          onRestored={() => router.refresh()}
        />
      )}
      {tab === "improve" && (
        <Improve
          flow={flow}
          versions={versions}
          moves={moves}
          comparisons={comparisons}
          bound={compiled.bound.agentRuns}
          onPreview={(m) =>
            void preview({
              graph: m.graph,
              title: m.title,
              why: `${m.hypothesis}. Cost: ${m.overhead}. Evidence: ${m.evidence}.`,
              source: "improve",
            })
          }
        />
      )}
      {runOpen && (
        <RunDialog
          flowId={flow.id}
          graph={graph}
          devices={devices}
          flush={flush}
          bound={compiled.bound.agentRuns}
          onClose={() => setRunOpen(false)}
        />
      )}
    </div>
  )
}

function Describe({
  graph,
  onProposal,
}: {
  graph: FlowGraph
  onProposal: (p: Proposal) => Promise<void>
}) {
  const [text, setText] = React.useState("")
  const [pending, start] = React.useTransition()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        start(async () => {
          const result = await designFlow({
            request: text,
            target: graph.target,
            current: graph,
          })
          if ("error" in result) toast.add({ title: result.error, type: "error" })
          else {
            await onProposal({
              graph: result.graph,
              title: result.name,
              why: result.why,
              source: "copilot",
            })
            setText("")
          }
        })
      }}
    >
      <Label htmlFor="describe" className="flex items-center gap-1.5 text-[12.5px]">
        <SparklesIcon className="size-3.5 text-rigel" /> Describe a change
      </Label>
      <Textarea
        id="describe"
        rows={2}
        maxLength={2000}
        placeholder="Add a check that the amount is mentioned"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button
        variant="outline"
        type="submit"
        disabled={pending || text.trim().length < 8}
        className="min-h-11 md:min-h-8"
      >
        {pending ? <Spinner /> : "Show me"}
      </Button>
    </form>
  )
}

function Runs({ flowId, runs }: { flowId: string; runs: FlowDetail["runs"] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 p-4 sm:p-6">
        {runs.length === 0 && (
          <p className="py-10 text-center text-[13px] text-muted-foreground">
            No runs yet. Press Run to see this flow work.
          </p>
        )}
        {runs.map((run) => (
          <Link
            key={run.id}
            href={`/flows/${flowId}/runs/${run.id}`}
            className="flex min-h-12 items-center gap-3 rounded-lg border bg-surface px-3 py-2 transition-colors hover:border-rigel/40"
          >
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="text-[13.5px] font-medium">{RUN_LABEL[run.status]}</span>
              <span className="truncate text-[11.5px] text-muted-foreground">
                {run.error ?? `Version ${run.version}`}
              </span>
            </span>
            {run.arm && (
              <span className="font-mono text-[10.5px] text-faint">{run.arm}</span>
            )}
            <span className="shrink-0 text-[11.5px] text-muted-foreground">
              {formatDistanceToNowStrict(new Date(run.createdAt), { addSuffix: true })}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}

function Versions({
  flowId,
  versions,
  draft,
  sourceRef,
  flush,
  onRestored,
}: {
  flowId: string
  versions: FlowDetail["versions"]
  draft: FlowGraph
  sourceRef: React.RefObject<"person" | "copilot" | "improve">
  flush: () => Promise<void>
  onRestored: () => void
}) {
  const [note, setNote] = React.useState("")
  const [pending, start] = React.useTransition()
  const latest = versions[0]
  const unsaved = latest ? diffGraphs(latest.graph, draft) : null
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <form
          className="flex flex-col gap-2 rounded-xl border bg-surface/60 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            start(async () => {
              await flush()
              const result = await saveVersion(flowId, {
                note,
                source: sourceRef.current,
              })
              if ("error" in result) toast.add({ title: result.error, type: "error" })
              else {
                sourceRef.current = "person"
                setNote("")
                onRestored()
              }
            })
          }}
        >
          <Label htmlFor="note" className="text-[12.5px]">
            {unsaved ? `Your draft: ${describeDiff(unsaved)}` : "Save the first version"}
          </Label>
          <div className="flex gap-2 max-sm:flex-col">
            <Input
              id="note"
              placeholder="What changed, for later"
              maxLength={400}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button type="submit" disabled={pending} className="min-h-11 sm:min-h-8">
              Save version
            </Button>
          </div>
        </form>
        {versions.length === 0 && (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            Versions appear when you save one, or when you run.
          </p>
        )}
        <ol className="flex flex-col gap-2">
          {versions.map((v, i) => {
            const previous = versions[i + 1]
            return (
              <li
                key={v.version}
                className="flex items-center gap-3 rounded-lg border bg-surface px-3 py-2.5"
              >
                <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
                  v{v.version}
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-[13.5px]">
                    {v.note || SOURCE_LABEL[v.source]}
                  </span>
                  <span className="truncate text-[11.5px] text-muted-foreground">
                    {SOURCE_LABEL[v.source]} ·{" "}
                    {formatDistanceToNowStrict(new Date(v.createdAt), {
                      addSuffix: true,
                    })}
                    {previous &&
                      ` · ${describeDiff(diffGraphs(previous.graph, v.graph))}`}
                  </span>
                </span>
                {i > 0 && (
                  <Confirm
                    trigger={
                      <Button variant="ghost" className="min-h-11 sm:min-h-8">
                        Restore
                      </Button>
                    }
                    title={`Restore version ${v.version}?`}
                    description="This becomes a new version and replaces your draft. History stays; runs in progress keep their version."
                    action="Restore"
                    onConfirm={async () => {
                      const result = await restoreVersion(flowId, v.version)
                      if ("error" in result)
                        toast.add({ title: result.error, type: "error" })
                      else window.location.reload()
                    }}
                  />
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

const VERDICT: Record<string, { label: string; tone: string; note: string }> = {
  adopt: {
    label: "Adopt",
    tone: "text-ok",
    note: "Better, at about the same cost per pass.",
  },
  canary: {
    label: "Promising",
    tone: "text-rigel",
    note: "It looks better; the evidence isn't conclusive.",
  },
  hold: {
    label: "Hold",
    tone: "text-muted-foreground",
    note: "Not enough to choose. Keep what you have.",
  },
  reject: { label: "Reject", tone: "text-destructive", note: "It did worse." },
}

function Improve({
  flow,
  versions,
  moves,
  comparisons,
  bound,
  onPreview,
}: {
  flow: FlowDetail["flow"]
  versions: FlowDetail["versions"]
  moves: Move[]
  comparisons: ComparisonView[]
  bound: number
  onPreview: (m: Move) => void
}) {
  const router = useRouter()
  const [a, setA] = React.useState(versions[1]?.version ?? 0)
  const [b, setB] = React.useState(versions[0]?.version ?? 0)
  const [rounds, setRounds] = React.useState(3)
  const [cases, setCases] = React.useState<Record<string, string>[]>(flow.cases)
  const inputs = flow.draft.inputs
  const total = Math.max(1, cases.length) * rounds * 2
  const select =
    "h-10 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring dark:bg-input/30"
  const setCase = (i: number, key: string, value: string) =>
    setCases(cases.map((c, n) => (n === i ? { ...c, [key]: value } : c)))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
        <section className="flex flex-col gap-2.5">
          <h2 className="label-mono">Worth trying</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            One change at a time, from this flow&apos;s shape and its own runs. None is
            applied until you say so, and none can touch an approval or a limit.
          </p>
          {moves.length === 0 && (
            <p className="rounded-lg border bg-surface/60 p-3 text-[13px] text-muted-foreground">
              Nothing stands out yet. Keeping a flow as it is is often the right answer.
            </p>
          )}
          {moves.map((m) => (
            <div
              key={m.title}
              className="flex flex-col gap-1.5 rounded-lg border bg-surface p-3"
            >
              <p className="text-[13.5px] font-medium">{m.title}</p>
              <p className="text-[12.5px] leading-snug text-muted-foreground">
                {m.hypothesis}.
              </p>
              <p className="font-mono text-[11px] text-faint">{m.evidence}</p>
              <div>
                <Button
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => onPreview(m)}
                >
                  Preview
                </Button>
              </div>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2.5">
          <h2 className="label-mono">Compare two versions</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            The same cases, run for run, then a paired test decides. Fewer than ten pairs
            reads &ldquo;Hold&rdquo;: small samples can&apos;t show much, and that&apos;s
            the honest answer.
          </p>
          {versions.length < 2 ? (
            <p className="rounded-lg border bg-surface/60 p-3 text-[13px] text-muted-foreground">
              Save two versions to compare them.
            </p>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border bg-surface/60 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label className="text-[12.5px]">Keep</Label>
                  <select
                    aria-label="Current version"
                    className={select}
                    value={a}
                    onChange={(e) => setA(Number(e.target.value))}
                  >
                    {versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-[12.5px]">Against</Label>
                  <select
                    aria-label="Candidate version"
                    className={select}
                    value={b}
                    onChange={(e) => setB(Number(e.target.value))}
                  >
                    {versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-[12.5px]">Rounds</Label>
                  <select
                    aria-label="Rounds"
                    className={select}
                    value={rounds}
                    onChange={(e) => setRounds(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>
              {inputs.length > 0 && (
                <div className="flex flex-col gap-2">
                  <Label className="text-[12.5px]">Cases</Label>
                  {cases.map((c, i) => (
                    <div key={i} className="flex gap-2">
                      {inputs.map((input) => (
                        <Input
                          key={input.key}
                          aria-label={input.label}
                          placeholder={input.label}
                          value={c[input.key] ?? ""}
                          onChange={(e) => setCase(i, input.key, e.target.value)}
                        />
                      ))}
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="ghost"
                      className="min-h-11 sm:min-h-8"
                      onClick={() => setCases([...cases, {}])}
                    >
                      Add a case
                    </Button>
                  </div>
                </div>
              )}
              <Confirm
                trigger={
                  <Button disabled={a === b} className="min-h-11 self-start sm:min-h-8">
                    Compare
                  </Button>
                }
                title={`Start ${total} real runs?`}
                description={`They use your plan's allowance, at most ${total * bound} agent runs. Actions inside them still ask you.`}
                action="Start"
                onConfirm={async () => {
                  const saved = await saveCases(flow.id, cases)
                  if ("error" in saved) {
                    toast.add({ title: saved.error, type: "error" })
                    return
                  }
                  const result = await startComparison(flow.id, {
                    incumbent: a,
                    candidate: b,
                    rounds,
                  })
                  if ("error" in result) toast.add({ title: result.error, type: "error" })
                  else router.refresh()
                }}
              />
            </div>
          )}
          {comparisons.map((c) => {
            const look = c.verdict ? VERDICT[c.verdict.verdict] : null
            return (
              <div
                key={c.comparisonId}
                className="flex flex-col gap-1 rounded-lg border bg-surface p-3"
              >
                <p className="flex items-center gap-2 text-[13.5px] font-medium">
                  v{c.incumbent} against v{c.candidate}
                  {look && <span className={look.tone}>{look.label}</span>}
                  {c.pending > 0 && (
                    <span className="text-[11.5px] font-normal text-muted-foreground">
                      {c.pending} still running
                    </span>
                  )}
                </p>
                {look && c.verdict && (
                  <>
                    <p className="text-[12.5px] text-muted-foreground">{look.note}</p>
                    <p className="font-mono text-[11px] leading-relaxed text-faint">
                      {c.verdict.pairs} pairs · only v{c.incumbent}:{" "}
                      {c.verdict.onlyIncumbent} · only v{c.candidate}:{" "}
                      {c.verdict.onlyCandidate} · p = {c.verdict.p.toFixed(3)} · pass{" "}
                      {c.verdict.incumbentPass / 10}% → {c.verdict.candidatePass / 10}%
                      {c.verdict.costChangePerMille === null
                        ? " · cost unknown"
                        : ` · cost per pass ${c.verdict.costChangePerMille > 0 ? "+" : ""}${c.verdict.costChangePerMille / 10}%`}
                    </p>
                    <ul className="text-[12px] text-muted-foreground">
                      {c.verdict.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )
          })}
        </section>

        <section className="border-t pt-4">
          <Confirm
            trigger={
              <Button
                variant="ghost"
                className="min-h-11 text-muted-foreground sm:min-h-8"
              >
                Archive this flow
              </Button>
            }
            title="Archive this flow?"
            description="It leaves your list. Its runs and what they did stay in your records."
            action="Archive"
            onConfirm={async () => {
              const result = await archiveFlow(flow.id)
              if ("error" in result) toast.add({ title: result.error, type: "error" })
              else router.push("/flows")
            }}
          />
        </section>
      </div>
    </div>
  )
}

type Project = { id: string; name?: string; path?: string; shown?: string }

function RunDialog({
  flowId,
  graph,
  devices,
  flush,
  bound,
  onClose,
}: {
  flowId: string
  graph: FlowGraph
  devices: Device[]
  flush: () => Promise<void>
  bound: number
  onClose: () => void
}) {
  const router = useRouter()
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [deviceId, setDeviceId] = React.useState(devices[0]?.id ?? "")
  const [project, setProject] = React.useState("")
  const [mode, setMode] = React.useState<"ask" | "auto" | "read" | "plan">("ask")
  const [pending, start] = React.useTransition()
  const device = devices.find((d) => d.id === deviceId)
  const projects = (Array.isArray(device?.projects) ? device.projects : []) as Project[]
  const needsDevice = graph.target === "device"
  const missing = graph.inputs.some((i) => i.required && !values[i.key]?.trim())
  const select =
    "h-10 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring dark:bg-input/30"
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run this flow</DialogTitle>
          <DialogDescription>
            {needsDevice
              ? "It runs on your computer, in the folder you choose. Your project's own check decides what passes."
              : `At most ${bound} agent ${bound === 1 ? "run" : "runs"}, within your plan. Anything risky still asks you first.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {graph.inputs.map((input) => (
            <div key={input.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`in-${input.key}`}>{input.label}</Label>
              <Textarea
                id={`in-${input.key}`}
                rows={input.long ? 4 : 1}
                maxLength={4000}
                value={values[input.key] ?? ""}
                onChange={(e) => setValues({ ...values, [input.key]: e.target.value })}
              />
            </div>
          ))}
          {needsDevice && (
            <>
              {devices.length === 0 ? (
                <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <CircleAlertIcon className="size-4" />
                  No computer is listening. Start <code>kriya daemon</code> on one.
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label>Computer</Label>
                    <select
                      aria-label="Computer"
                      className={select}
                      value={deviceId}
                      onChange={(e) => setDeviceId(e.target.value)}
                    >
                      {devices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Folder</Label>
                    <select
                      aria-label="Folder"
                      className={select}
                      value={project}
                      onChange={(e) => setProject(e.target.value)}
                    >
                      <option value="">Choose a folder</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.shown ?? p.name ?? p.path ?? p.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Permissions</Label>
                    <select
                      aria-label="Permissions"
                      className={select}
                      value={mode}
                      onChange={(e) => setMode(e.target.value as typeof mode)}
                    >
                      <option value="ask">Ask</option>
                      <option value="auto">Auto</option>
                      <option value="read">Read only</option>
                      <option value="plan">Plan</option>
                    </select>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" className="min-h-11 sm:min-h-8" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="min-h-11 sm:min-h-8"
            disabled={pending || missing || (needsDevice && (!deviceId || !project))}
            onClick={() =>
              start(async () => {
                await flush()
                const result = await startRun(flowId, {
                  inputs: values,
                  ...(needsDevice && { device: { deviceId, project, mode } }),
                })
                if ("error" in result) toast.add({ title: result.error, type: "error" })
                else router.push(`/flows/${flowId}/runs/${result.runId}`)
              })
            }
          >
            {pending ? <Spinner /> : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
