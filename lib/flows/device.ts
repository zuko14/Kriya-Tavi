import { and, eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { z } from "zod"

import { privileged } from "@/db"
import { flowNodeRuns, flowRuns, type FlowRun } from "@/db/schema"

import type { Plan } from "./compile"
import type { FlowGraph, FlowNode } from "./graph"

// Device flows (SD-14): a graph of steps becomes a Loop v2 plan and a harness
// profile, sent as the Control Center's `run` action. The computer's loop
// decides pass, retry and blocked from exit codes; this only mirrors what it
// reported into node rows, so one run page shows both targets.

export type DevicePlan = {
  goal: string
  steps: { title: string; done_when: string; files: string[]; after?: number[] }[]
}

/** Steps in topological order; every `after` points back, as Loop v2 requires */
export function devicePlan(graph: FlowGraph, plan: Plan): DevicePlan {
  const order = plan.children[""].filter((id) => plan.nodes[id].type === "step")
  const start = graph.nodes.find((n) => n.type === "start")
  const goal = start?.type === "start" ? (start.config.goal ?? "") : ""
  const number = new Map(order.map((id, i) => [id, i + 1]))
  return {
    goal,
    steps: order.map((id) => {
      const node = plan.nodes[id] as Extract<FlowNode, { type: "step" }>
      const after = (plan.incoming[id] ?? [])
        .map((e) => number.get(e.from))
        .filter((n): n is number => n !== undefined)
      return {
        title: node.title,
        done_when: node.config.doneWhen,
        files: node.config.files,
        after: [...new Set(after)].sort((a, b) => a - b),
      }
    }),
  }
}

/** The plan in words: an older client has only this to follow */
export const planPrompt = (p: DevicePlan) =>
  [
    p.goal,
    `Plan this with kriya_plan exactly as written, then build each step with kriya_step:`,
    ...p.steps.map(
      (s, i) =>
        `${i + 1}. ${s.title}. Done when: ${s.done_when}${s.after?.length ? ` (after ${s.after.join(", ")})` : ""}`
    ),
  ].join("\n")

// What the daemon reports while the plan runs (kriya-harness src/daemon.js)
const Reported = z.object({
  plan: z
    .array(
      z.object({
        n: z.number().int(),
        title: z.string(),
        status: z.string(),
        attempts: z.number().int().optional(),
        building: z.unknown().optional(),
      })
    )
    .max(20)
    .optional(),
  verdict: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  answer: z.string().optional(),
  error: z.string().optional(),
})

// Loop v2's step states as node states
function stepState(status: string, building: boolean) {
  if (building) return { status: "running" as const, port: null }
  if (status === "pass" || status === "built")
    return { status: "done" as const, port: "out" }
  if (status === "blocked") return { status: "failed" as const, port: null }
  if (status === "skipped") return { status: "skipped" as const, port: null }
  return null
}

export async function mirrorDevice(
  run: FlowRun,
  plan: Plan,
  dispatch: { status: string; result: unknown },
  now: Date
) {
  const parsed = Reported.safeParse(dispatch.result ?? {})
  const report = parsed.success ? parsed.data : {}
  const order = plan.children[""].filter((id) => plan.nodes[id].type === "step")
  const rows = await privileged
    .select()
    .from(flowNodeRuns)
    .where(and(eq(flowNodeRuns.runId, run.id), eq(flowNodeRuns.userId, run.userId)))
  const write = async (
    nodeId: string,
    status: (typeof flowNodeRuns.$inferInsert)["status"],
    port: string | null,
    detail: Record<string, unknown> = {},
    output?: string
  ) => {
    const row = rows.find((r) => r.nodeId === nodeId)
    const settled = status !== "running" && status !== "waiting"
    const values = {
      status,
      port,
      detail,
      ...(output !== undefined && { output: output.slice(0, 8000) }),
      ...(settled && { finishedAt: now }),
    }
    if (!row) {
      await privileged
        .insert(flowNodeRuns)
        .values({
          id: nanoid(12),
          userId: run.userId,
          runId: run.id,
          nodeId,
          scope: "",
          attempt: 1,
          ...values,
        })
        .onConflictDoNothing()
    } else if (
      row.status !== status &&
      (row.status === "running" || row.status === "waiting")
    )
      await privileged
        .update(flowNodeRuns)
        .set(values)
        .where(and(eq(flowNodeRuns.id, row.id), eq(flowNodeRuns.userId, run.userId)))
  }

  const start = plan.children[""].find((id) => plan.nodes[id].type === "start")
  if (start) await write(start, "done", "out")
  for (const [i, id] of order.entries()) {
    const step = report.plan?.find((s) => s.n === i + 1)
    if (!step) continue
    const state = stepState(step.status, Boolean(step.building))
    if (state)
      await write(id, state.status, state.port, {
        attempts: step.attempts ?? 0,
        ...(state.status === "failed" && {
          reason: `Blocked after ${step.attempts ?? 0} attempts.`,
        }),
      })
  }

  const finished = ["done", "failed", "canceled", "expired"].includes(dispatch.status)
  if (!finished) return "running" as const
  const canceled = dispatch.status === "canceled" || dispatch.status === "expired"
  const end = plan.children[""].find((id) => plan.nodes[id].type === "end")
  const steps = report.plan ?? []
  // Done needs the computer's verdict: every step passed its check
  const verified =
    steps.length === order.length && steps.every((s) => s.status === "pass")
  const passed =
    dispatch.status === "done" && (verified || (!report.plan && report.exitCode === 0))
  if (passed && end) await write(end, "done", null, {}, report.answer ?? "")
  await privileged
    .update(flowRuns)
    .set({
      status: canceled ? "canceled" : passed ? "completed" : "failed",
      output: report.answer?.slice(0, 8000) ?? null,
      error: passed
        ? null
        : canceled
          ? "It was stopped."
          : (report.error ?? "The plan didn't pass on your computer.").slice(0, 1000),
      finishedAt: now,
    })
    .where(and(eq(flowRuns.id, run.id), eq(flowRuns.userId, run.userId)))
  return "finished" as const
}
