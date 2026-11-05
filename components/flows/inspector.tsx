"use client"

import * as React from "react"
import { ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { RULE_LABEL, TYPE_LOOK } from "@/components/flows/look"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { before, type Bound, type Issue, type Plan } from "@/lib/flows/compile"
import { LIMITS, type FlowGraph, type FlowNode, type Rule } from "@/lib/flows/graph"
import type { HarnessProfile } from "@/lib/harness/evolve/profile-schema"
import { cn } from "@/lib/utils"
import type { AgentOption } from "@/queries/flows"

const select =
  "h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[12.5px]">{label}</Label>
      {children}
      {hint && <p className="text-[11.5px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

// What this text may name, from what runs before it (SD-06)
function Refs({
  graph,
  plan,
  node,
  onPick,
}: {
  graph: FlowGraph
  plan: Plan | null
  node: FlowNode
  onPick: (ref: string) => void
}) {
  const earlier = plan
    ? [...before(plan, node.id)]
    : graph.nodes.filter((n) => n.id !== node.id).map((n) => n.id)
  const refs = [
    ...graph.inputs.map((i) => ({ ref: `{{input.${i.key}}}`, label: i.label })),
    ...earlier
      .map((id) => graph.nodes.find((n) => n.id === id)!)
      .filter((n) => n && !["start", "end"].includes(n.type))
      .map((n) => ({ ref: `{{${n.id}}}`, label: n.title })),
    ...(node.parent
      ? [
          { ref: "{{loop.feedback}}", label: "What failed last round" },
          { ref: "{{loop.last}}", label: "Last round's result" },
          { ref: "{{loop.iteration}}", label: "Round number" },
        ]
      : []),
  ]
  if (refs.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {refs.map(({ ref, label }) => (
        <button
          key={ref}
          type="button"
          onClick={() => onPick(ref)}
          title={`Insert ${ref}`}
          className="rounded-md border bg-background/50 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-rigel/40 hover:text-rigel"
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function RuleFields({
  rule,
  agents,
  onChange,
}: {
  rule: Rule
  agents: { id: string; title: string }[]
  onChange: (rule: Rule) => void
}) {
  const kind = (value: string): Rule => {
    if (value === "tool_ran")
      return {
        kind: "tool_ran",
        node: agents[0]?.id ?? "",
        tool: "gmail_draft",
        atLeast: 1,
      }
    if (["min_chars", "max_chars", "number_at_least", "number_at_most"].includes(value))
      return { kind: value, n: 100 } as Rule
    return { kind: value, text: "" } as Rule
  }
  return (
    <>
      <Field label="It passes when">
        <select
          className={select}
          value={rule.kind}
          onChange={(e) => onChange(kind(e.target.value))}
        >
          {Object.entries(RULE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {"text" in rule && (
        <Field label="Text">
          <Input
            value={rule.text}
            maxLength={400}
            onChange={(e) => onChange({ ...rule, text: e.target.value })}
          />
        </Field>
      )}
      {"n" in rule && (
        <Field label="Value">
          <Input
            type="number"
            value={rule.n}
            onChange={(e) => onChange({ ...rule, n: Number(e.target.value) || 0 })}
          />
        </Field>
      )}
      {rule.kind === "tool_ran" && (
        <>
          <Field
            label="Which step"
            hint="Read from what really ran, never from what the agent says."
          >
            <select
              className={select}
              value={rule.node}
              onChange={(e) => onChange({ ...rule, node: e.target.value })}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tool">
            <Input
              value={rule.tool}
              onChange={(e) => onChange({ ...rule, tool: e.target.value.trim() })}
            />
          </Field>
          <Field label="At least">
            <Input
              type="number"
              min={1}
              max={100}
              value={rule.atLeast}
              onChange={(e) =>
                onChange({ ...rule, atLeast: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </Field>
        </>
      )}
    </>
  )
}

function NodeFields({
  node,
  graph,
  plan,
  agents,
  onChange,
}: {
  node: FlowNode
  graph: FlowGraph
  plan: Plan | null
  agents: AgentOption[]
  onChange: (node: FlowNode) => void
}) {
  const config = <T extends FlowNode>(n: T, change: Partial<T["config"]>) =>
    onChange({ ...n, config: { ...n.config, ...change } } as FlowNode)
  const area = (
    label: string,
    value: string,
    set: (v: string) => void,
    hint?: string
  ) => (
    <Field label={label} hint={hint}>
      <Textarea
        rows={5}
        value={value}
        maxLength={LIMITS.text}
        onChange={(e) => set(e.target.value)}
      />
      <Refs
        graph={graph}
        plan={plan}
        node={node}
        onPick={(ref) => set(`${value}${value && !value.endsWith(" ") ? " " : ""}${ref}`)}
      />
    </Field>
  )
  switch (node.type) {
    case "start":
      return graph.target === "device" ? (
        <Field label="Goal" hint="What the plan is for, in a sentence or two.">
          <Textarea
            rows={4}
            value={node.config.goal ?? ""}
            maxLength={LIMITS.goal}
            onChange={(e) => config(node, { goal: e.target.value })}
          />
        </Field>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          A run starts here. Add the things you&apos;ll fill in each time under Inputs,
          with nothing selected.
        </p>
      )
    case "agent":
      return (
        <>
          <Field
            label="Agent"
            hint="It works with its own tools, and asks you before anything risky, as in chat."
          >
            <select
              className={select}
              value={node.config.agentId}
              onChange={(e) => config(node, { agentId: e.target.value })}
            >
              <option value="">Choose an agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          {area("What to do", node.config.prompt, (prompt) => config(node, { prompt }))}
          <Collapsible>
            <CollapsibleTrigger className="group/more flex min-h-9 items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3.5 transition-transform group-data-[panel-open]/more:rotate-90" />
              Limits and recovery
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <Field
                label="Tries when it fails"
                hint="Only if it did nothing real. After a side effect, Kriya stops and asks you."
              >
                <select
                  className={select}
                  value={node.config.retries}
                  onChange={(e) => config(node, { retries: Number(e.target.value) })}
                >
                  <option value={0}>Once</option>
                  <option value={1}>Up to twice</option>
                  <option value={2}>Up to three times</option>
                </select>
              </Field>
            </CollapsibleContent>
          </Collapsible>
        </>
      )
    case "check":
      return (
        <>
          {area("What to check", node.config.subject, (subject) =>
            config(node, { subject })
          )}
          <RuleFields
            rule={node.config.rule}
            agents={graph.nodes.filter((n) => n.type === "agent")}
            onChange={(rule) => config(node, { rule })}
          />
        </>
      )
    case "approval":
      return (
        <>
          {area("What you'll be shown", node.config.message, (message) =>
            config(node, { message })
          )}
          <Field label="Hours to answer" hint="If nobody answers, it counts as declined.">
            <Input
              type="number"
              min={1}
              max={168}
              value={node.config.expiresHours}
              onChange={(e) =>
                config(node, {
                  expiresHours: Math.min(168, Math.max(1, Number(e.target.value) || 1)),
                })
              }
            />
          </Field>
        </>
      )
    case "merge":
      return (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Waits for every path that runs, and hands on what they found, labelled.
        </p>
      )
    case "loop": {
      const checks = graph.nodes.filter((n) => n.parent === node.id && n.type === "check")
      return (
        <>
          <Field
            label="Rounds at most"
            hint="It also stops early if a round changes nothing."
          >
            <Input
              type="number"
              min={1}
              max={LIMITS.iterations}
              value={node.config.maxIterations}
              onChange={(e) =>
                config(node, {
                  maxIterations: Math.min(
                    LIMITS.iterations,
                    Math.max(1, Number(e.target.value) || 1)
                  ),
                })
              }
            />
          </Field>
          <Field label="Ends when this passes">
            <select
              className={select}
              value={node.config.until}
              onChange={(e) => config(node, { until: e.target.value })}
            >
              <option value="">Choose a check inside the loop</option>
              {checks.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </Field>
        </>
      )
    }
    case "end":
      return area("What the flow returns", node.config.result, (result) =>
        config(node, { result })
      )
    case "step":
      return (
        <>
          <Field
            label="Done when"
            hint="Your project's own check decides; you can't name a command here."
          >
            <Textarea
              rows={3}
              value={node.config.doneWhen}
              maxLength={LIMITS.doneWhen}
              onChange={(e) => config(node, { doneWhen: e.target.value })}
            />
          </Field>
          <Field label="Files it touches" hint="One per line, optional.">
            <Textarea
              rows={3}
              value={node.config.files.join("\n")}
              onChange={(e) =>
                config(node, {
                  files: e.target.value
                    .split("\n")
                    .map((f) => f.trim())
                    .filter(Boolean)
                    .slice(0, LIMITS.files),
                })
              }
            />
          </Field>
        </>
      )
  }
}

const PROFILE_FIELDS: { key: keyof HarnessProfile; label: string; hint: string }[] = [
  {
    key: "loopV2",
    label: "Loop v2",
    hint: "Failure classes, set-aside attempts, tests held on the originals",
  },
  {
    key: "budget",
    label: "Turn budget",
    hint: "Stops a turn at its step and time limits",
  },
  {
    key: "anchor",
    label: "Keep the request word for word",
    hint: "Survives long sessions",
  },
  { key: "minimalTools", label: "Minimal tools", hint: "A shorter tool list" },
]

function Settings({
  graph,
  bound,
  onChange,
}: {
  graph: FlowGraph
  bound: Bound
  onChange: (graph: FlowGraph) => void
}) {
  const input = (i: number, change: Partial<FlowGraph["inputs"][number]>) =>
    onChange({
      ...graph,
      inputs: graph.inputs.map((x, n) => (n === i ? { ...x, ...change } : x)),
    })
  const p = graph.profile
  return (
    <>
      <div className="rounded-lg border bg-background/40 p-3">
        <p className="label-mono">Worst case</p>
        <p className="mt-1 text-[13px]">
          At most <span className="font-medium tabular-nums">{bound.agentRuns}</span>{" "}
          {graph.target === "device"
            ? "steps"
            : `agent ${bound.agentRuns === 1 ? "run" : "runs"}`}
          {bound.gates > 0 && (
            <>
              , <span className="tabular-nums">{bound.gates}</span>{" "}
              {bound.gates === 1 ? "question" : "questions"} for you
            </>
          )}
          .
        </p>
      </div>
      {graph.target === "cloud" && (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-[12.5px]">Inputs</Label>
              <Button
                size="xs"
                variant="ghost"
                disabled={graph.inputs.length >= LIMITS.inputs}
                onClick={() => {
                  const n = graph.inputs.length + 1
                  onChange({
                    ...graph,
                    inputs: [
                      ...graph.inputs,
                      {
                        key: `input_${n}`,
                        label: `Input ${n}`,
                        required: true,
                        long: false,
                      },
                    ],
                  })
                }}
              >
                <PlusIcon /> Add
              </Button>
            </div>
            {graph.inputs.length === 0 && (
              <p className="text-[11.5px] text-muted-foreground">
                What you fill in each time you run it.
              </p>
            )}
            {graph.inputs.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  aria-label="Input label"
                  value={item.label}
                  maxLength={LIMITS.title}
                  onChange={(e) =>
                    input(i, {
                      label: e.target.value,
                      key:
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "_")
                          .replace(/^_+|_+$/g, "")
                          .replace(/^[^a-z]+/, "")
                          .slice(0, 32) || item.key,
                    })
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${item.label}`}
                  onClick={() =>
                    onChange({ ...graph, inputs: graph.inputs.filter((_, n) => n !== i) })
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          </div>
          <Field label="Budget per run (₹)" hint="Empty means your plan's limits alone.">
            <Input
              type="number"
              min={1}
              value={graph.limits.budgetInr ?? ""}
              onChange={(e) =>
                onChange({
                  ...graph,
                  limits: {
                    budgetInr: e.target.value
                      ? Math.max(1, Math.round(Number(e.target.value)))
                      : null,
                  },
                })
              }
            />
          </Field>
        </>
      )}
      {p && (
        <div className="flex flex-col gap-2.5">
          <p className="label-mono">Harness</p>
          {PROFILE_FIELDS.map(({ key, label, hint }) => (
            <label key={key} className="flex min-h-9 items-start gap-2.5 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--rigel)]"
                checked={Boolean(p[key])}
                onChange={(e) =>
                  onChange({ ...graph, profile: { ...p, [key]: e.target.checked } })
                }
              />
              <span className="leading-tight">
                {label}
                <span className="block text-[11.5px] text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
          <Field label="Steps per turn">
            <Input
              type="number"
              min={20}
              max={400}
              value={p.maxSteps}
              onChange={(e) =>
                onChange({
                  ...graph,
                  profile: {
                    ...p,
                    maxSteps: Math.min(400, Math.max(20, Number(e.target.value) || 20)),
                  },
                })
              }
            />
          </Field>
          <Field label="Minutes per turn">
            <Input
              type="number"
              min={5}
              max={120}
              value={p.turnMinutes}
              onChange={(e) =>
                onChange({
                  ...graph,
                  profile: {
                    ...p,
                    turnMinutes: Math.min(120, Math.max(5, Number(e.target.value) || 5)),
                  },
                })
              }
            />
          </Field>
        </div>
      )}
    </>
  )
}

export function Inspector({
  graph,
  plan,
  bound,
  issues,
  agents,
  selected,
  onChange,
  onSelect,
  onRemove,
  className,
}: {
  graph: FlowGraph
  plan: Plan | null
  bound: Bound
  issues: Issue[]
  agents: AgentOption[]
  selected: string | null
  onChange: (graph: FlowGraph) => void
  onSelect: (id: string | null) => void
  onRemove: (id: string) => void
  className?: string
}) {
  const node = graph.nodes.find((n) => n.id === selected)
  const update = (next: FlowNode) =>
    onChange({ ...graph, nodes: graph.nodes.map((n) => (n.id === next.id ? next : n)) })
  const loops = graph.nodes.filter((n) => n.type === "loop" && n.id !== node?.id)
  const mine = issues.filter((i) => !node || i.node === node.id)
  return (
    <aside
      className={cn("flex h-full min-h-0 flex-col overflow-y-auto", className)}
      aria-label="Inspector"
    >
      <div className="flex flex-col gap-4 p-4">
        {node ? (
          <>
            <div className="flex items-center gap-2">
              <p className="label-mono">{TYPE_LOOK[node.type].label}</p>
              {node.type !== "start" && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={`Remove ${node.title}`}
                  onClick={() => onRemove(node.id)}
                >
                  <Trash2Icon />
                </Button>
              )}
            </div>
            <Field label="Name">
              <Input
                value={node.title}
                maxLength={LIMITS.title}
                onChange={(e) => update({ ...node, title: e.target.value || " " })}
              />
            </Field>
            <NodeFields
              node={node}
              graph={graph}
              plan={plan}
              agents={agents}
              onChange={update}
            />
            {loops.length > 0 &&
              !["start", "end"].includes(node.type) &&
              graph.target === "cloud" && (
                <Field label="Inside" hint="Moving a step clears its connections.">
                  <select
                    className={select}
                    value={node.parent ?? ""}
                    onChange={(e) => {
                      const parent = e.target.value || undefined
                      onChange({
                        ...graph,
                        nodes: graph.nodes.map((n) => {
                          if (n.id !== node.id) return n
                          return {
                            ...n,
                            parent,
                            at: { x: 32, y: 56 },
                          } as FlowNode
                        }),
                        edges: graph.edges.filter(
                          (x) => x.from !== node.id && x.to !== node.id
                        ),
                      })
                    }}
                  >
                    <option value="">The main flow</option>
                    {loops.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
          </>
        ) : (
          <Settings graph={graph} bound={bound} onChange={onChange} />
        )}
        {mine.length > 0 && (
          <ul className="flex flex-col gap-1.5" aria-label="Problems">
            {mine.map((issue, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => issue.node && onSelect(issue.node)}
                  className={cn(
                    "w-full rounded-md border px-2.5 py-1.5 text-left text-[12px] leading-snug",
                    issue.severity === "error"
                      ? "border-destructive/30 text-destructive"
                      : "border-warn/30 text-muted-foreground"
                  )}
                >
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
