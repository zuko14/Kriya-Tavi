import { generateText, type LanguageModel } from "ai"
import { and, eq, gte, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import { z } from "zod"

import { privileged } from "@/db"
import { resourceUsage } from "@/db/schema"
import { log } from "@/lib/log"
import { usageFromMetadata } from "@/lib/models"
import { jsonInstructions, parseJsonReply } from "@/lib/skill-studio/design"

import { compile, type Issue } from "./compile"
import { FlowGraph, FlowNode, LIMITS, PORTS, type FlowEdge, type Target } from "./graph"

// The describe box (SD-12): one capped model call, the Skill Studio pattern.
// The model drafts; the same validator as a person's graph decides; the person
// previews and applies. It has no tool and can save, publish or run nothing.

const NodeDraft = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  parent: z.string().nullish(),
  agent: z.string().nullish(),
  prompt: z.string().nullish(),
  subject: z.string().nullish(),
  rule: z.record(z.string(), z.unknown()).nullish(),
  message: z.string().nullish(),
  maxIterations: z.number().nullish(),
  until: z.string().nullish(),
  result: z.string().nullish(),
  doneWhen: z.string().nullish(),
  goal: z.string().nullish(),
})

export const Draft = z.object({
  name: z.string(),
  why: z.string(),
  inputs: z
    .array(
      z.object({ key: z.string(), label: z.string(), required: z.boolean().nullish() })
    )
    .nullish(),
  nodes: z.array(NodeDraft),
  edges: z.array(
    z.object({ from: z.string(), port: z.string().nullish(), to: z.string() })
  ),
})
export type Draft = z.infer<typeof Draft>

const at = { x: 0, y: 0 }

/** A model's draft as a strict graph; compile() still judges it */
export function toGraph(
  draft: Draft,
  target: Target,
  agents: { id: string }[],
  profile?: FlowGraph["profile"]
): FlowGraph | null {
  const known = new Set(agents.map((a) => a.id))
  const nodes = draft.nodes.map((n) => {
    const base = {
      id: n.id,
      title: n.title.slice(0, LIMITS.title),
      at,
      ...(n.parent && { parent: n.parent }),
    }
    switch (n.type) {
      case "start":
        return { ...base, type: n.type, config: n.goal ? { goal: n.goal } : {} }
      case "agent":
        return {
          ...base,
          type: n.type,
          config: {
            // Only the person's agents; anything else becomes the first of them
            agentId: n.agent && known.has(n.agent) ? n.agent : (agents[0]?.id ?? ""),
            prompt: n.prompt ?? "",
            retries: 0,
          },
        }
      case "check":
        return {
          ...base,
          type: n.type,
          config: { subject: n.subject ?? "", rule: n.rule },
        }
      case "approval":
        return {
          ...base,
          type: n.type,
          config: { message: n.message ?? "", expiresHours: 72 },
        }
      case "merge":
        return { ...base, type: n.type, config: {} }
      case "loop":
        return {
          ...base,
          type: n.type,
          config: {
            maxIterations: Math.min(n.maxIterations ?? 3, LIMITS.iterations),
            until: n.until ?? "",
          },
        }
      case "end":
        return { ...base, type: n.type, config: { result: n.result ?? "" } }
      case "step":
        return {
          ...base,
          type: n.type,
          config: { doneWhen: n.doneWhen ?? "", files: [] },
        }
      default:
        return null
    }
  })
  if (nodes.some((n) => !n)) return null
  const typeOf = new Map(draft.nodes.map((n) => [n.id, n.type]))
  const edges: FlowEdge[] = draft.edges.map((e) => {
    const port = e.port ?? PORTS[typeOf.get(e.from) as FlowNode["type"]]?.[0] ?? "out"
    return { id: `${e.from}:${port}:${e.to}`, from: e.from, port, to: e.to }
  })
  const parsed = FlowGraph.safeParse({
    schema: 1,
    target,
    inputs: (draft.inputs ?? []).map((i) => ({
      key: i.key,
      label: i.label,
      required: i.required ?? true,
      long: false,
    })),
    nodes,
    edges,
    limits: { budgetInr: null },
    ...(profile && { profile }),
  })
  return parsed.success ? parsed.data : null
}

const CLOUD_GUIDE = `Node types and their ways out:
- start: exactly one. Port out.
- agent: one of the person's agents does work. "agent" is its id, "prompt" what to do. Ports out, error.
- check: code judges a value; "subject" is what to judge, like "{{draft}}"; "rule" is one of {"kind":"contains","text":…}, {"kind":"not_contains","text":…}, {"kind":"equals","text":…}, {"kind":"min_chars","n":…}, {"kind":"max_chars","n":…}, {"kind":"number_at_least","n":…}, {"kind":"number_at_most","n":…}, {"kind":"tool_ran","node":"<agent node>","tool":"<tool name>","atLeast":1}. Ports pass, fail. Use it for branching too.
- approval: pauses for the person; "message" says what they're approving. Ports approved, declined.
- merge: joins parallel paths. Port out.
- loop: repeats its body, the nodes with "parent" set to its id. "maxIterations" 1–10, "until" the id of a check in the body. Ports done, exhausted. Connect edges to the loop itself, never across its edge. The body's first nodes have no incoming edge.
- end: one or more. "result" is what the flow returns, like "{{write}}". No ports out.
Data moves only through references in text: {{input.key}}, {{nodeId}}, and inside a loop {{loop.iteration}}, {{loop.feedback}}, {{loop.last}}. Reference only nodes that run earlier. Never make a cycle: to repeat, use a loop.`

const DEVICE_GUIDE = `This flow runs on the person's computer as Kriya's coding loop. Use only: start (with "goal": the task in one or two sentences), step ("title", "doneWhen": how to know it's done), end. At most ${LIMITS.steps} steps. Edges say which step needs which, always forward. The project's own check verifies each step; you can't name a command.`

function designPrompt(
  target: Target,
  agents: { id: string; name: string; role: string }[]
) {
  return [
    "You design flows for Kriya: small graphs of agents and rules that do a job. Prefer the simplest graph that does the job: one agent is a fine answer. Add parallel paths only for independent work, a loop only with a real check to pass, an approval before anything the person would want to see first. Never invent tools, agents or data.",
    target === "device" ? DEVICE_GUIDE : CLOUD_GUIDE,
    target === "cloud"
      ? `The person's agents:\n${agents.map((a) => `- ${a.id}: ${a.name} (${a.role})`).join("\n")}`
      : "",
    `Ids are lower-case letters, digits and _, starting with a letter. "why" says in two sentences why this shape, and what you left out.`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const graphForPrompt = (graph: FlowGraph) =>
  JSON.stringify({
    inputs: graph.inputs,
    nodes: graph.nodes.map((n) => ({ ...n, at: undefined })),
    edges: graph.edges.map((e) => ({ from: e.from, port: e.port, to: e.to })),
  })

export async function designFlow(input: {
  userId: string
  model: LanguageModel
  request: string
  target: Target
  agents: { id: string; name: string; role: string }[]
  current?: FlowGraph
  profile?: FlowGraph["profile"]
  maxAgentRuns: number
}) {
  const key = nanoid(10)
  const ask = input.current
    ? `Change this flow as asked, and keep everything else.\nThe flow: ${graphForPrompt(input.current)}\nWhat to change: ${input.request}`
    : `The job: ${input.request}`
  let problem: string | null = null
  for (const attempt of [1, 2]) {
    const prompt: string = problem
      ? `${ask}\n\nYour previous reply couldn't be used: ${problem} Reply again with only the JSON object.`
      : ask
    const result = await generateText({
      model: input.model,
      instructions: `${designPrompt(input.target, input.agents)}\n\n${jsonInstructions(Draft)}`,
      prompt,
      maxOutputTokens: 6000,
      maxRetries: 1,
    })
    await privileged
      .insert(resourceUsage)
      .values({
        requestKey: `flow-design:${key}:${attempt}`,
        userId: input.userId,
        kind: "flow_design",
        quantity: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
        costMicroUsd: usageFromMetadata(result.providerMetadata)?.costMicroUsd ?? null,
      })
      .onConflictDoNothing()
      .catch((error) => log.error("flow design usage failed", { error }))
    const parsed: ReturnType<typeof parseJsonReply<Draft>> = parseJsonReply(
      result.text,
      Draft
    )
    if (!parsed.ok) {
      problem = parsed.problem
      continue
    }
    const graph = toGraph(parsed.value, input.target, input.agents, input.profile)
    if (!graph) {
      problem = "A node or edge didn't fit the shape described."
      continue
    }
    const compiled = compile(graph, { maxAgentRuns: input.maxAgentRuns })
    const errors = compiled.issues.filter((i: Issue) => i.severity === "error")
    if (errors.length) {
      problem = errors
        .slice(0, 5)
        .map((i: Issue) => i.message)
        .join(" ")
      // Sizes and reasons only: the reply carries the person's request
      log.warn("flow design refused", { attempt, errors: errors.length })
      continue
    }
    return {
      name: parsed.value.name.slice(0, LIMITS.title),
      why: parsed.value.why.slice(0, 600),
      graph,
    }
  }
  return null
}

export async function designsToday(userId: string) {
  const [{ n }] = await privileged
    .select({ n: sql<number>`count(*)::int` })
    .from(resourceUsage)
    .where(
      and(
        eq(resourceUsage.userId, userId),
        eq(resourceUsage.kind, "flow_design"),
        gte(resourceUsage.createdAt, new Date(Date.now() - 86_400_000))
      )
    )
  return n
}
