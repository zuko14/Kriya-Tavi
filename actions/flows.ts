"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { ControlError } from "@/lib/harness/control"
import { designFlow as design, designsToday } from "@/lib/flows/copilot"
import { emptyGraph, FlowGraph, TARGETS } from "@/lib/flows/graph"
import { flowsOn } from "@/lib/flows/on"
import {
  answerGate as answer,
  archive,
  cancelRun as cancel,
  createFlow as create,
  FlowError,
  maxNodeRuns,
  rerunFrom as rerun,
  rerunPreview as preview,
  restoreVersion as restore,
  retryNode as retry,
  saveCases as storeCases,
  saveDraft as storeDraft,
  saveVersion as storeVersion,
  startComparison as compare,
  startRun as start,
} from "@/lib/flows/store"
import { BASELINE } from "@/lib/harness/evolve/profile-schema"
import { templateById, withAgent } from "@/lib/flows/templates"
import {
  createGatewayModel,
  isGatewayConfigured,
  ModelConfigError,
  modelForTier,
} from "@/lib/models"
import { allow, allowAll, clientIp } from "@/lib/rate-limit"
import { agentOptions } from "@/queries/flows"

// Flows (docs/kriya-studio/). Identity from the session only; a graph is
// untrusted input, validated in lib/flows/store.ts. Answering a gate, retrying
// and adopting are the person's alone: no agent tool reaches this file.

type Failed = { error: string }

const id = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)
const name = z.string().trim().min(1, "Give it a name.").max(80)

async function expected<T>(work: () => Promise<T>): Promise<T | Failed> {
  try {
    if (!(await flowsOn())) return { error: "Flows aren't available yet." }
    return await work()
  } catch (error) {
    if (error instanceof FlowError || error instanceof ControlError)
      return { error: error.message }
    if (error instanceof z.ZodError)
      return { error: error.issues[0]?.message ?? "That wasn't valid." }
    throw error
  }
}

const NewFlow = z.object({
  name,
  description: z.string().max(400).optional(),
  template: z.string().max(40).optional(),
  target: z.enum(TARGETS).optional(),
  graph: FlowGraph.optional(),
  note: z.string().max(400).optional(),
})

export async function createFlow(input: unknown) {
  const user = await requireUser()
  return expected(async () => {
    const parsed = NewFlow.parse(input)
    const agents = await agentOptions(user.id)
    const template = parsed.template ? templateById(parsed.template) : undefined
    if (parsed.template && !template)
      throw new FlowError("That starting point isn't here.")
    let graph = parsed.graph ?? template?.graph
    const target = graph?.target ?? parsed.target ?? "cloud"
    if (target === "device" && (await getSetting("studio.deviceFlows")) !== "on")
      throw new FlowError("Flows on your computer aren't available yet.")
    if (!graph && target === "device")
      graph = { ...emptyGraph("device"), profile: BASELINE }
    if (graph && agents[0]) graph = withAgent(graph, agents[0].id)
    const flowId = await create(user.id, {
      name: parsed.name,
      description: parsed.description,
      target,
      graph,
    })
    revalidatePath("/flows")
    return { id: flowId }
  })
}

export async function saveDraft(flowId: string, input: unknown) {
  const user = await requireUser()
  return expected(async () => {
    const body = z
      .object({
        graph: z.unknown(),
        rev: z.number().int().min(0),
        name: name.optional(),
        description: z.string().max(400).optional(),
      })
      .parse(input)
    return { rev: await storeDraft(user.id, id.parse(flowId), body) }
  })
}

export async function saveVersion(flowId: string, input: unknown) {
  const user = await requireUser()
  return expected(async () => {
    const body = z
      .object({
        note: z.string().max(400).optional(),
        source: z.enum(["person", "copilot", "improve"]).optional(),
      })
      .parse(input)
    const version = await storeVersion(user.id, id.parse(flowId), body)
    revalidatePath(`/flows/${flowId}`)
    return { version }
  })
}

export async function restoreVersion(flowId: string, version: number) {
  const user = await requireUser()
  return expected(async () => {
    const made = await restore(
      user.id,
      id.parse(flowId),
      z.number().int().min(1).parse(version)
    )
    revalidatePath(`/flows/${flowId}`)
    return { version: made }
  })
}

export async function archiveFlow(flowId: string) {
  const user = await requireUser()
  return expected(async () => {
    await archive(user.id, id.parse(flowId))
    revalidatePath("/flows")
    return { ok: true as const }
  })
}

const Device = z.object({
  deviceId: z.uuid(),
  project: z.string().max(64),
  mode: z.enum(["ask", "auto", "read", "plan"]),
})

export async function startRun(flowId: string, input: unknown) {
  const user = await requireUser()
  return expected(async () => {
    if (!(await allow(`flows:run:${user.id}`, 20, 60)))
      throw new FlowError("Too many runs. Wait a minute and try again.")
    const body = z
      .object({
        inputs: z.record(z.string(), z.string().max(4000)).optional(),
        version: z.number().int().min(1).optional(),
        device: Device.optional(),
      })
      .parse(input)
    const runId = await start(user.id, id.parse(flowId), body)
    revalidatePath(`/flows/${flowId}`)
    return { runId }
  })
}

export async function cancelRun(runId: string) {
  const user = await requireUser()
  return expected(async () => {
    await cancel(user.id, id.parse(runId))
    return { ok: true as const }
  })
}

export async function answerGate(nodeRunId: string, approved: boolean) {
  const user = await requireUser()
  return expected(async () => {
    await answer(user.id, id.parse(nodeRunId), z.boolean().parse(approved))
    revalidatePath("/inbox")
    return { ok: true as const }
  })
}

export async function retryNode(runId: string, nodeRunId: string) {
  const user = await requireUser()
  return expected(async () => {
    await retry(user.id, id.parse(runId), id.parse(nodeRunId))
    return { ok: true as const }
  })
}

export async function rerunPreview(runId: string, nodeId: string) {
  const user = await requireUser()
  return expected(() => preview(user.id, id.parse(runId), id.parse(nodeId)))
}

export async function rerunFrom(runId: string, nodeId: string) {
  const user = await requireUser()
  return expected(async () => ({
    runId: await rerun(user.id, id.parse(runId), id.parse(nodeId)),
  }))
}

export async function saveCases(flowId: string, cases: unknown) {
  const user = await requireUser()
  return expected(async () => {
    await storeCases(user.id, id.parse(flowId), cases)
    return { ok: true as const }
  })
}

export async function startComparison(flowId: string, input: unknown) {
  const user = await requireUser()
  return expected(async () => {
    const body = z
      .object({
        incumbent: z.number().int().min(1),
        candidate: z.number().int().min(1),
        rounds: z.number().int().min(1).max(5),
      })
      .parse(input)
    const comparisonId = await compare(user.id, id.parse(flowId), body)
    revalidatePath(`/flows/${flowId}`)
    return { comparisonId }
  })
}

/** The describe box: a preview only. Nothing is saved until the person applies it */
export async function designFlow(input: unknown) {
  const user = await requireUser()
  return expected(async () => {
    if ((await getSetting("studio.copilot")) !== "on")
      throw new FlowError("Describing a flow isn't available yet.")
    const body = z
      .object({
        request: z.string().trim().min(8, "Say a little more.").max(2000),
        target: z.enum(TARGETS),
        current: FlowGraph.optional(),
      })
      .parse(input)
    if (!isGatewayConfigured())
      throw new FlowError("Kriya can't reach its models right now. Try again later.")
    const daily = Number(await getSetting("studio.copilotDaily")) || 20
    if ((await designsToday(user.id)) >= daily)
      throw new FlowError(`That's ${daily} designs today. Try again tomorrow.`)
    const ok = await allowAll([
      [`flows:design:ip:${await clientIp()}`, 20, 3600],
      [`flows:design:${user.id}`, 10, 3600],
    ])
    if (!ok) throw new FlowError("Too many designs. Wait a little and try again.")
    let model: string
    try {
      model = await modelForTier("balanced")
    } catch (error) {
      if (error instanceof ModelConfigError)
        throw new FlowError("Kriya can't reach its models right now. Try again later.")
      throw error
    }
    const agents = await agentOptions(user.id)
    const result = await design({
      userId: user.id,
      model: createGatewayModel(model),
      request: body.request,
      target: body.target,
      agents,
      current: body.current,
      profile: body.target === "device" ? (body.current?.profile ?? BASELINE) : undefined,
      maxAgentRuns: await maxNodeRuns(),
    })
    if (!result)
      throw new FlowError("That design didn't come out valid. Try saying it differently.")
    return result
  })
}
