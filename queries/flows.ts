import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"

import { withUser } from "@/db"
import {
  agents,
  charges,
  flowNodeRuns,
  flowRuns,
  flows,
  flowVersions,
  tasks,
  toolExecutions,
} from "@/db/schema"
import { getSetting } from "@/lib/config"
import { controlCenter } from "@/lib/harness/control"
import { joinedGlyph } from "@/lib/glyph"
import { compile } from "@/lib/flows/compile"
import { compareVerdict, type CompareRun } from "@/lib/flows/compare"
import { asRow } from "@/lib/flows/rows"
import { flowsOn } from "@/lib/flows/on"

// Reads for Flows, all as the person (RLS).

export async function listFlows(userId: string) {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(flows)
      .where(isNull(flows.archivedAt))
      .orderBy(desc(flows.updatedAt))
      .limit(100)
    if (rows.length === 0) return []
    const runs = await tx
      .selectDistinctOn([flowRuns.flowId], {
        flowId: flowRuns.flowId,
        status: flowRuns.status,
        createdAt: flowRuns.createdAt,
      })
      .from(flowRuns)
      .where(
        inArray(
          flowRuns.flowId,
          rows.map((f) => f.id)
        )
      )
      .orderBy(flowRuns.flowId, desc(flowRuns.createdAt))
    const last = new Map(runs.map((r) => [r.flowId, r]))
    return rows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      description: flow.description,
      target: flow.target,
      steps: flow.draft.nodes.filter((n) => !["start", "end"].includes(n.type)).length,
      updatedAt: flow.updatedAt,
      lastRun: last.get(flow.id) ?? null,
    }))
  })
}
export type FlowListItem = Awaited<ReturnType<typeof listFlows>>[number]

export async function agentOptions(userId: string) {
  const rows = await withUser(userId, (tx) =>
    tx
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        glyph: agents.glyph,
      })
      .from(agents)
      .orderBy(asc(agents.createdAt))
  )
  return rows.map((a) => ({ ...a, glyph: joinedGlyph(a.glyph, a.role) }))
}
export type AgentOption = Awaited<ReturnType<typeof agentOptions>>[number]

export async function getFlow(userId: string, flowId: string) {
  return withUser(userId, async (tx) => {
    const [flow] = await tx
      .select()
      .from(flows)
      .where(and(eq(flows.id, flowId), isNull(flows.archivedAt)))
    if (!flow) return null
    const versions = await tx
      .select()
      .from(flowVersions)
      .where(eq(flowVersions.flowId, flowId))
      .orderBy(desc(flowVersions.version))
      .limit(50)
    const runs = await tx
      .select({
        id: flowRuns.id,
        status: flowRuns.status,
        version: flowRuns.version,
        error: flowRuns.error,
        comparisonId: flowRuns.comparisonId,
        arm: flowRuns.arm,
        forkedFrom: flowRuns.forkedFrom,
        createdAt: flowRuns.createdAt,
        finishedAt: flowRuns.finishedAt,
      })
      .from(flowRuns)
      .where(eq(flowRuns.flowId, flowId))
      .orderBy(desc(flowRuns.createdAt))
      .limit(30)
    return { flow, versions, runs }
  })
}
export type FlowDetail = NonNullable<Awaited<ReturnType<typeof getFlow>>>

export async function getRun(userId: string, runId: string) {
  return withUser(userId, async (tx) => {
    const [run] = await tx.select().from(flowRuns).where(eq(flowRuns.id, runId))
    if (!run) return null
    const [[flow], [version], rows] = await Promise.all([
      tx
        .select({ id: flows.id, name: flows.name, target: flows.target })
        .from(flows)
        .where(eq(flows.id, run.flowId)),
      tx
        .select({ graph: flowVersions.graph, source: flowVersions.source })
        .from(flowVersions)
        .where(
          and(eq(flowVersions.flowId, run.flowId), eq(flowVersions.version, run.version))
        ),
      tx
        .select()
        .from(flowNodeRuns)
        .where(eq(flowNodeRuns.runId, runId))
        .orderBy(asc(flowNodeRuns.startedAt)),
    ])
    const taskIds = rows.flatMap((r) => (r.taskId && !r.reusedFrom ? [r.taskId] : []))
    const money = taskIds.length
      ? await tx
          .select({
            taskId: charges.taskId,
            charge: charges.chargeMicroInr,
            status: charges.status,
          })
          .from(charges)
          .where(inArray(charges.taskId, taskIds))
      : []
    const threadIds = rows.flatMap((r) => (r.threadId ? [r.threadId] : []))
    const tools = threadIds.length
      ? await tx
          .select({
            threadId: tasks.threadId,
            name: toolExecutions.toolName,
            status: toolExecutions.status,
            sideEffect: toolExecutions.sideEffect,
            summary: toolExecutions.outputSummary,
            ms: toolExecutions.durationMs,
          })
          .from(toolExecutions)
          .innerJoin(tasks, eq(tasks.id, toolExecutions.taskId))
          .where(inArray(tasks.threadId, threadIds))
          .orderBy(asc(toolExecutions.startedAt))
          .limit(200)
      : []
    const named = version!.graph.nodes.flatMap((n) =>
      n.type === "agent" ? [n.config.agentId] : []
    )
    const people = named.length
      ? await tx
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, named))
      : []
    return {
      run: {
        id: run.id,
        status: run.status,
        version: run.version,
        inputs: run.inputs,
        output: run.output,
        error: run.error,
        forkedFrom: run.forkedFrom,
        device: Boolean(run.deviceId),
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
      flow: flow!,
      graph: version!.graph,
      rows: rows.map((r) => ({
        id: r.id,
        nodeId: r.nodeId,
        scope: r.scope,
        attempt: r.attempt,
        status: r.status,
        port: r.port,
        iteration: r.iteration,
        output: r.output,
        detail: r.detail,
        threadId: r.threadId,
        reused: Boolean(r.reusedFrom),
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        // Null until priced: never shown as zero
        chargeMicroInr: (() => {
          const found = money.find((m) => m.taskId === r.taskId)
          return found?.charge === null || found?.charge === undefined
            ? null
            : String(found.charge)
        })(),
        tools: tools.filter((t) => t.threadId === r.threadId),
      })),
      agents: people,
    }
  })
}
export type RunView = NonNullable<Awaited<ReturnType<typeof getRun>>>

/** Gates waiting for the person, for the Inbox; off = not queried */
export async function waitingGates(userId: string) {
  if (!(await flowsOn())) return []
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        id: flowNodeRuns.id,
        runId: flowNodeRuns.runId,
        nodeId: flowNodeRuns.nodeId,
        message: flowNodeRuns.output,
        detail: flowNodeRuns.detail,
        startedAt: flowNodeRuns.startedAt,
        flowId: flowRuns.flowId,
        flowName: flows.name,
        graph: flowVersions.graph,
      })
      .from(flowNodeRuns)
      .innerJoin(flowRuns, eq(flowRuns.id, flowNodeRuns.runId))
      .innerJoin(flows, eq(flows.id, flowRuns.flowId))
      .innerJoin(
        flowVersions,
        and(
          eq(flowVersions.flowId, flowRuns.flowId),
          eq(flowVersions.version, flowRuns.version)
        )
      )
      .where(
        and(
          eq(flowNodeRuns.status, "waiting"),
          inArray(flowRuns.status, ["running", "waiting"])
        )
      )
      .orderBy(desc(flowNodeRuns.startedAt))
      .limit(50)
    return rows.flatMap(({ graph, ...row }) => {
      const node = graph.nodes.find((n) => n.id === row.nodeId)
      return node?.type === "approval" ? [{ ...row, title: node.title }] : []
    })
  })
}
export type WaitingGate = Awaited<ReturnType<typeof waitingGates>>[number]

export async function comparisons(userId: string, flowId: string) {
  return withUser(userId, async (tx) => {
    const runs = await tx
      .select()
      .from(flowRuns)
      .where(and(eq(flowRuns.flowId, flowId), sql`${flowRuns.comparisonId} is not null`))
      .orderBy(desc(flowRuns.createdAt))
      .limit(200)
    if (runs.length === 0) return []
    const ids = runs.map((r) => r.id)
    const rows = await tx
      .select()
      .from(flowNodeRuns)
      .where(inArray(flowNodeRuns.runId, ids))
    const money = await tx
      .select({ runId: flowNodeRuns.runId, charge: charges.chargeMicroInr })
      .from(flowNodeRuns)
      .leftJoin(charges, eq(charges.taskId, flowNodeRuns.taskId))
      .where(
        and(inArray(flowNodeRuns.runId, ids), sql`${flowNodeRuns.taskId} is not null`)
      )
    const versions = await tx
      .select()
      .from(flowVersions)
      .where(eq(flowVersions.flowId, flowId))
    const planOf = (version: number) =>
      compile(versions.find((v) => v.version === version)?.graph, {
        maxAgentRuns: Number.MAX_SAFE_INTEGER,
      }).plan
    return [...new Set(runs.map((r) => r.comparisonId!))].flatMap((comparisonId) => {
      const mine = runs.filter((r) => r.comparisonId === comparisonId)
      const a = mine.find((r) => r.arm === "incumbent")
      const b = mine.find((r) => r.arm === "candidate")
      const incumbent = a && planOf(a.version)
      const candidate = b && planOf(b.version)
      if (!a || !b || !incumbent || !candidate) return []
      const views: CompareRun[] = mine.map((r) => {
        const charged = money.filter((m) => m.runId === r.id)
        return {
          arm: r.arm,
          caseIndex: r.caseIndex,
          round: r.round,
          status: r.status,
          durationMs:
            r.startedAt && r.finishedAt
              ? r.finishedAt.getTime() - r.startedAt.getTime()
              : 0,
          // Unknown stays unknown: any unpriced node makes the run's cost null
          costMicroInr:
            charged.length && charged.every((m) => m.charge !== null)
              ? charged.reduce((s, m) => s + BigInt(m.charge!), 0n)
              : null,
          rows: rows.filter((x) => x.runId === r.id).map(asRow),
        }
      })
      const { pending, verdict } = compareVerdict(comparisonId, views, {
        incumbent,
        candidate,
      })
      return [
        {
          comparisonId,
          incumbent: a.version,
          candidate: b.version,
          runs: mine.length,
          pending,
          verdict: verdict
            ? {
                verdict: verdict.verdict,
                reasons: verdict.reasons,
                pairs: verdict.metrics.pairs,
                onlyIncumbent: verdict.metrics.onlyIncumbent,
                onlyCandidate: verdict.metrics.onlyCandidate,
                p: verdict.metrics.p,
                incumbentPass: verdict.metrics.incumbent.passPerMille,
                candidatePass: verdict.metrics.candidate.passPerMille,
                costChangePerMille: verdict.metrics.costChangePerMille,
              }
            : null,
        },
      ]
    })
  })
}
export type ComparisonView = Awaited<ReturnType<typeof comparisons>>[number]

export async function deviceTargets(userId: string) {
  if ((await getSetting("studio.deviceFlows")) !== "on") return []
  const { devices } = await controlCenter(userId)
  return devices
}
