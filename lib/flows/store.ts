import { createHash } from "node:crypto"

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, withUser, type Tx } from "@/db"
import {
  agents,
  flowNodeRuns,
  flowRuns,
  flows,
  flowVersions,
  type FlowRun,
  type FlowSource,
} from "@/db/schema"
import { getSetting } from "@/lib/config"
import { queue } from "@/lib/harness/control"
import { profileId, toEnv } from "@/lib/harness/evolve/profile"

import { after, canonical, compile, semanticGraph, topOf, type Compiled } from "./compile"
import { devicePlan, planPrompt } from "./device"
import { latestRows } from "./engine"
import { FlowGraph, emptyGraph, LIMITS, type Target } from "./graph"
import { asRow, nodeRowsOf, planOf, stop } from "./run"

// The person's side of Flows (actions/flows.ts): drafts, versions and starting
// or steering runs. Identity comes from the caller's session; flows and
// versions go through withUser (RLS). Run rows are server-written, so those
// writes are privileged and scoped by user id, after an RLS read proves the
// run is the person's (invariant 1).

export class FlowError extends Error {
  constructor(
    message: string,
    readonly code = "bad_request"
  ) {
    super(message)
    this.name = "FlowError"
  }
}

export const RUN_HOURS = 48

const hashOf = (graph: FlowGraph) =>
  createHash("sha256")
    .update(canonical(semanticGraph(graph)))
    .digest("hex")

export async function maxNodeRuns() {
  return Number(await getSetting("studio.maxNodeRuns")) || 40
}

const ownFlow = async (tx: Tx, flowId: string) => {
  const [flow] = await tx
    .select()
    .from(flows)
    .where(and(eq(flows.id, flowId), isNull(flows.archivedAt)))
  if (!flow) throw new FlowError("This flow isn't there.", "not_found")
  return flow
}

/** Agents named by a graph must be the person's (S3); read through RLS */
export async function checkAgents(tx: Tx, graph: FlowGraph) {
  const ids = [
    ...new Set(
      graph.nodes.flatMap((n) => (n.type === "agent" ? [n.config.agentId] : []))
    ),
  ]
  if (ids.length === 0) return
  const found = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(inArray(agents.id, ids))
  if (found.length !== ids.length)
    throw new FlowError("A node names an agent that isn't one of yours.")
}

export async function createFlow(
  userId: string,
  input: { name: string; description?: string; target?: Target; graph?: FlowGraph }
) {
  const target = input.target ?? input.graph?.target ?? "cloud"
  const draft = input.graph ?? emptyGraph(target)
  const parsed = FlowGraph.safeParse(draft)
  if (!parsed.success) throw new FlowError("That flow isn't valid.")
  const id = nanoid(12)
  await withUser(userId, async (tx) => {
    await checkAgents(tx, parsed.data)
    await tx.insert(flows).values({
      id,
      userId,
      name: input.name,
      description: input.description ?? "",
      target,
      draft: parsed.data,
    })
  })
  return id
}

/** Autosave. A stale tab is refused rather than overwriting newer work */
export async function saveDraft(
  userId: string,
  flowId: string,
  input: { graph: unknown; rev: number; name?: string; description?: string }
) {
  const parsed = FlowGraph.safeParse(input.graph)
  if (!parsed.success) throw new FlowError("That flow isn't valid.")
  return withUser(userId, async (tx) => {
    const flow = await ownFlow(tx, flowId)
    if (parsed.data.target !== flow.target)
      throw new FlowError("A flow can't change where it runs.")
    await checkAgents(tx, parsed.data)
    const [saved] = await tx
      .update(flows)
      .set({
        draft: parsed.data,
        draftRev: input.rev + 1,
        ...(input.name && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
      })
      .where(and(eq(flows.id, flowId), eq(flows.draftRev, input.rev)))
      .returning({ rev: flows.draftRev })
    if (!saved)
      throw new FlowError(
        "This flow changed in another tab. Reload to continue.",
        "stale"
      )
    return saved.rev
  })
}

async function appendVersion(
  tx: Tx,
  userId: string,
  flowId: string,
  latest: number,
  graph: FlowGraph,
  source: FlowSource,
  note: string,
  parent?: number
) {
  const version = latest + 1
  await tx.insert(flowVersions).values({
    flowId,
    version,
    userId,
    graph,
    hash: hashOf(graph),
    source,
    note,
    parentVersion: parent ?? (latest || null),
  })
  await tx.update(flows).set({ latestVersion: version }).where(eq(flows.id, flowId))
  return version
}

function mustCompile(graph: unknown, maxAgentRuns: number): Compiled {
  const compiled = compile(graph, { maxAgentRuns })
  const first = compiled.issues.find((i) => i.severity === "error")
  if (first) throw new FlowError(first.message, "invalid")
  return compiled
}

/** The draft as a version; the same flow again is the same version (SD-10) */
export async function saveVersion(
  userId: string,
  flowId: string,
  { note = "", source = "person" }: { note?: string; source?: FlowSource } = {}
) {
  const limit = await maxNodeRuns()
  return withUser(userId, async (tx) => {
    const flow = await ownFlow(tx, flowId)
    mustCompile(flow.draft, limit)
    await checkAgents(tx, flow.draft)
    if (flow.latestVersion > 0) {
      const [last] = await tx
        .select({ hash: flowVersions.hash })
        .from(flowVersions)
        .where(
          and(
            eq(flowVersions.flowId, flowId),
            eq(flowVersions.version, flow.latestVersion)
          )
        )
      if (last?.hash === hashOf(flow.draft)) return flow.latestVersion
    }
    return appendVersion(tx, userId, flowId, flow.latestVersion, flow.draft, source, note)
  })
}

/** Restoring appends a copy: history is never rewritten */
export async function restoreVersion(userId: string, flowId: string, version: number) {
  return withUser(userId, async (tx) => {
    const flow = await ownFlow(tx, flowId)
    const [old] = await tx
      .select()
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.version, version)))
    if (!old) throw new FlowError("That version isn't there.", "not_found")
    await checkAgents(tx, old.graph)
    const made = await appendVersion(
      tx,
      userId,
      flowId,
      flow.latestVersion,
      old.graph,
      "rollback",
      `Restored version ${version}`,
      version
    )
    await tx
      .update(flows)
      .set({ draft: old.graph, draftRev: flow.draftRev + 1 })
      .where(eq(flows.id, flowId))
    return made
  })
}

export async function archive(userId: string, flowId: string) {
  await withUser(userId, async (tx) => {
    await ownFlow(tx, flowId)
    await tx.update(flows).set({ archivedAt: new Date() }).where(eq(flows.id, flowId))
  })
}

function cleanInputs(graph: FlowGraph, raw: Record<string, unknown>) {
  const inputs: Record<string, string> = {}
  for (const input of graph.inputs) {
    const value = raw[input.key]
    const text = typeof value === "string" ? value.trim().slice(0, LIMITS.text) : ""
    if (input.required && !text) throw new FlowError(`Fill in ${input.label}.`)
    inputs[input.key] = text
  }
  return inputs
}

// The daily limit, held while the runs are inserted (invariant 7)
async function insertRuns(userId: string, values: (typeof flowRuns.$inferInsert)[]) {
  const limit = Number(await getSetting("studio.dailyRuns")) || 50
  return privileged.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`flows:${userId}`}))`)
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(flowRuns)
      .where(
        and(
          eq(flowRuns.userId, userId),
          gte(flowRuns.createdAt, new Date(Date.now() - 86_400_000))
        )
      )
    if (n + values.length > limit)
      throw new FlowError(`You've used today's ${limit} flow runs.`, "limit")
    return tx.insert(flowRuns).values(values).returning({ id: flowRuns.id })
  })
}

const deadline = () => new Date(Date.now() + RUN_HOURS * 3_600_000)

const budgetOf = (graph: FlowGraph) =>
  graph.limits.budgetInr ? graph.limits.budgetInr * 1_000_000 : null

export async function startRun(
  userId: string,
  flowId: string,
  input: {
    inputs?: Record<string, unknown>
    version?: number
    device?: { deviceId: string; project: string; mode: "ask" | "auto" | "read" | "plan" }
  }
) {
  const limit = await maxNodeRuns()
  const version = input.version ?? (await saveVersion(userId, flowId))
  const row = await withUser(userId, async (tx) => {
    const [found] = await tx
      .select()
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.version, version)))
    if (!found) throw new FlowError("That version isn't there.", "not_found")
    await checkAgents(tx, found.graph)
    return found
  })
  const graph = row.graph
  const { plan } = mustCompile(graph, limit)
  const inputs = cleanInputs(graph, input.inputs ?? {})
  const base = {
    userId,
    flowId,
    version,
    inputs,
    budgetMicroInr: budgetOf(graph),
    deadlineAt: deadline(),
  }
  if (graph.target === "cloud") {
    const [run] = await insertRuns(userId, [{ id: nanoid(12), ...base }])
    return run.id
  }
  if ((await getSetting("studio.deviceFlows")) !== "on")
    throw new FlowError("Flows on your computer aren't available yet.")
  if (!input.device) throw new FlowError("Choose a computer and a folder.")
  const steps = devicePlan(graph, plan!)
  const p = graph.profile!
  const dispatchId = await queue(userId, input.device.deviceId, "run", {
    project: input.device.project,
    prompt: planPrompt(steps).slice(0, 4000),
    mode: input.device.mode,
    switches: { loopV2: p.loopV2, budget: p.budget, anchor: p.anchor, browser: true },
    plan: {
      ...steps,
      steps: steps.steps.map((s) => ({
        ...s,
        after: s.after?.length ? s.after : undefined,
      })),
    },
    profile: { id: profileId(p), env: toEnv(p) },
  })
  const [run] = await insertRuns(userId, [
    {
      id: nanoid(12),
      ...base,
      deviceId: input.device.deviceId,
      project: input.device.project,
      mode: input.device.mode,
      dispatchId,
    },
  ])
  return run.id
}

// The run, read as the person: someone else's id finds nothing (S3)
async function ownRun(userId: string, runId: string): Promise<FlowRun> {
  const [run] = await withUser(userId, (tx) =>
    tx.select().from(flowRuns).where(eq(flowRuns.id, runId))
  )
  if (!run) throw new FlowError("This run isn't there.", "not_found")
  return run
}

const wake = (run: Pick<FlowRun, "id" | "userId">) =>
  privileged
    .update(flowRuns)
    .set({ reviewAt: new Date() })
    .where(and(eq(flowRuns.id, run.id), eq(flowRuns.userId, run.userId)))

export async function cancelRun(userId: string, runId: string) {
  const run = await ownRun(userId, runId)
  if (!["queued", "running", "waiting"].includes(run.status))
    throw new FlowError("This run has already ended.", "stale")
  if (run.dispatchId) {
    const { cancel } = await import("@/lib/harness/control")
    await cancel(userId, run.dispatchId).catch(() => {})
  }
  await stop(run, undefined, "canceled")
}

/** The person's answer at a gate: session only, no agent tool reaches it (S7) */
export async function answerGate(userId: string, nodeRunId: string, approved: boolean) {
  const [row] = await withUser(userId, (tx) =>
    tx.select().from(flowNodeRuns).where(eq(flowNodeRuns.id, nodeRunId))
  )
  if (!row) throw new FlowError("This request isn't there.", "not_found")
  const run = await ownRun(userId, row.runId)
  const plan = await planOf(run)
  if (plan.nodes[row.nodeId]?.type !== "approval")
    throw new FlowError("This step is answered in its own thread.")
  const [answered] = await privileged
    .update(flowNodeRuns)
    .set({
      status: "done",
      port: approved ? "approved" : "declined",
      finishedAt: new Date(),
      detail: {
        ...row.detail,
        ...(approved ? {} : { reason: "You declined." }),
      },
    })
    .where(
      and(
        eq(flowNodeRuns.id, nodeRunId),
        eq(flowNodeRuns.userId, userId),
        eq(flowNodeRuns.status, "waiting")
      )
    )
    .returning({ id: flowNodeRuns.id })
  if (!answered)
    throw new FlowError("This isn't waiting for an answer any more.", "stale")
  await wake(run)
}

/**
 * Another attempt at a failed agent node; what finished stays (SD-09). Other
 * failed nodes that did nothing real go with it, so parallel branches don't
 * need a click each; one that did something runs again only when named.
 */
export async function retryNode(userId: string, runId: string, nodeRunId: string) {
  const run = await ownRun(userId, runId)
  if (run.status !== "failed") throw new FlowError("Only a failed run can be retried.")
  const rows = await nodeRowsOf(run)
  const failed = rows.find((r) => r.id === nodeRunId)
  if (!failed || failed.status !== "failed")
    throw new FlowError("That step didn't fail.", "stale")
  const plan = await planOf(run)
  if (plan.nodes[failed.nodeId]?.type !== "agent")
    throw new FlowError("Only an agent step can be retried.")
  const latest = latestRows(rows.map(asRow))
  const again = [...latest.values()].filter(
    (r) =>
      r.status === "failed" &&
      plan.nodes[r.nodeId]?.type === "agent" &&
      ((r.nodeId === failed.nodeId && r.scope === failed.scope) ||
        !r.detail.sideEffects?.length)
  )
  await privileged.transaction(async (tx) => {
    await tx.insert(flowNodeRuns).values(
      again.map((r) => ({
        id: nanoid(12),
        userId,
        runId,
        nodeId: r.nodeId,
        scope: r.scope,
        attempt: r.attempt + 1,
        status: "running" as const,
        iteration: r.iteration,
      }))
    )
    await tx
      .update(flowRuns)
      .set({
        status: "running",
        error: null,
        finishedAt: null,
        reviewAt: new Date(),
        deadlineAt: deadline(),
      })
      .where(and(eq(flowRuns.id, runId), eq(flowRuns.userId, userId)))
  })
}

/** What a re-run from `nodeId` would repeat: real actions first, so the person sees them */
export async function rerunPreview(userId: string, runId: string, nodeId: string) {
  const run = await ownRun(userId, runId)
  const plan = await planOf(run)
  const from = topOf(plan, nodeId)
  const again = new Set([from, ...after(plan, from)])
  const rows = await nodeRowsOf(run)
  const repeat = rows.filter((r) => again.has(topOf(plan, r.nodeId)))
  return {
    from,
    reused: rows.filter((r) => !again.has(topOf(plan, r.nodeId))).length,
    sideEffects: [...new Set(repeat.flatMap((r) => r.detail.sideEffects ?? []))],
  }
}

/** A new run that reuses recorded results before `nodeId`; those aren't executed */
export async function rerunFrom(userId: string, runId: string, nodeId: string) {
  const source = await ownRun(userId, runId)
  if (source.deviceId) throw new FlowError("Run this flow again from your computer.")
  const plan = await planOf(source)
  if (!plan.nodes[nodeId]) throw new FlowError("That step isn't in this version.")
  const from = topOf(plan, nodeId)
  const again = new Set([from, ...after(plan, from)])
  const rows = await nodeRowsOf(source)
  const copied = rows.filter(
    (r) =>
      !again.has(topOf(plan, r.nodeId)) && (r.status === "done" || r.status === "skipped")
  )
  const id = nanoid(12)
  await insertRuns(userId, [
    {
      id,
      userId,
      flowId: source.flowId,
      version: source.version,
      inputs: source.inputs,
      budgetMicroInr: source.budgetMicroInr,
      deadlineAt: deadline(),
      forkedFrom: source.id,
    },
  ])
  if (copied.length)
    await privileged.insert(flowNodeRuns).values(
      copied.map((r) => ({
        id: nanoid(12),
        userId,
        runId: id,
        nodeId: r.nodeId,
        scope: r.scope,
        attempt: r.attempt,
        status: r.status,
        port: r.port,
        iteration: r.iteration,
        taskId: r.taskId,
        threadId: r.threadId,
        output: r.output,
        detail: r.detail,
        reusedFrom: r.id,
        finishedAt: r.finishedAt,
      }))
    )
  return id
}

export const MAX_COMPARE_RUNS = 60

/** The saved inputs for Compare */
export async function saveCases(userId: string, flowId: string, cases: unknown) {
  const list = Array.isArray(cases) ? cases.slice(0, 20) : []
  const clean = list.map((c) =>
    Object.fromEntries(
      Object.entries(c as Record<string, unknown>).map(([k, v]) => [
        k.slice(0, 32),
        String(v ?? "").slice(0, LIMITS.text),
      ])
    )
  )
  await withUser(userId, async (tx) => {
    await ownFlow(tx, flowId)
    await tx.update(flows).set({ cases: clean }).where(eq(flows.id, flowId))
  })
}

/**
 * Two versions, paired on the same cases (SD-13). Each case runs `rounds`
 * times on each version, interleaved, so a slow afternoon hits both arms.
 * Real runs: every limit applies and the person saw the worst case first.
 */
export async function startComparison(
  userId: string,
  flowId: string,
  input: { incumbent: number; candidate: number; rounds: number }
) {
  if (input.incumbent === input.candidate)
    throw new FlowError("Choose two different versions.")
  const limit = await maxNodeRuns()
  const { flow, versions } = await withUser(userId, async (tx) => {
    const flow = await ownFlow(tx, flowId)
    const versions = await tx
      .select()
      .from(flowVersions)
      .where(
        and(
          eq(flowVersions.flowId, flowId),
          inArray(flowVersions.version, [input.incumbent, input.candidate])
        )
      )
    for (const v of versions) await checkAgents(tx, v.graph)
    return { flow, versions }
  })
  if (versions.length !== 2) throw new FlowError("That version isn't there.", "not_found")
  if (flow.target !== "cloud") throw new FlowError("Compare works on cloud flows.")
  for (const v of versions) {
    mustCompile(v.graph, limit)
    if (!v.graph.nodes.some((n) => n.type === "check"))
      throw new FlowError(`Version ${v.version} has no check, so nothing can judge it.`)
  }
  const graphOf = (version: number) => versions.find((v) => v.version === version)!.graph
  const cases = flow.cases.length ? flow.cases : [{}]
  const rounds = Math.min(Math.max(input.rounds, 1), 5)
  if (cases.length * rounds * 2 > MAX_COMPARE_RUNS)
    throw new FlowError(
      `That's more than ${MAX_COMPARE_RUNS} runs. Use fewer cases or rounds.`
    )
  const comparisonId = nanoid(12)
  const values = []
  for (let round = 1; round <= rounds; round++)
    for (const [caseIndex, inputs] of cases.entries())
      for (const arm of ["incumbent", "candidate"] as const) {
        const version = arm === "incumbent" ? input.incumbent : input.candidate
        values.push({
          id: nanoid(12),
          userId,
          flowId,
          version,
          inputs: cleanInputs(graphOf(version), inputs),
          budgetMicroInr: budgetOf(graphOf(version)),
          deadlineAt: deadline(),
          comparisonId,
          arm,
          caseIndex,
          round,
        })
      }
  await insertRuns(userId, values)
  return comparisonId
}

export const flowRowsForEvidence = async (userId: string, flowId: string, take = 40) => {
  const runs = await withUser(userId, (tx) =>
    tx
      .select()
      .from(flowRuns)
      .where(eq(flowRuns.flowId, flowId))
      .orderBy(desc(flowRuns.createdAt))
      .limit(take)
  )
  const rows = runs.length
    ? await withUser(userId, (tx) =>
        tx
          .select()
          .from(flowNodeRuns)
          .where(
            inArray(
              flowNodeRuns.runId,
              runs.map((r) => r.id)
            )
          )
      )
    : []
  return { runs, rows: rows.map((r) => ({ ...asRow(r), runId: r.runId })) }
}
