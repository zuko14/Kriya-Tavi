import {
  convertToModelMessages,
  type ModelMessage,
  isStepCount,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type UIMessageChunk,
} from "ai"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, rowsOf, withUser } from "@/db"
import {
  connections,
  memories,
  plans,
  squadMembers,
  taskAttempts,
  taskEvents,
  tasks,
  threads,
  toolExecutions,
  type Agent,
  type Squad,
  type Task,
  type Tier,
} from "@/db/schema"
import {
  assignmentBlock,
  buildInstructions,
  type MemoryNote,
} from "@/lib/agent/instructions"
import {
  compactContext,
  describeError,
  loadMessages,
  previewOf,
  saveMessage,
  textOf,
} from "@/lib/agent/messages"
import { chargeTask, recordUsage } from "@/lib/agent/metering"
import {
  createAssignTool,
  createConnectorTools,
  createDelegateTool,
  createMemoryTools,
  createWebTools,
  SIDE_EFFECT_TOOLS,
  type Assignment,
  type AssignRunner,
  privateContentSeen,
  type Connected,
  type KriyaMessage,
  type ToolEnv,
} from "@/lib/agent/tools"
import { googleServices } from "@/lib/connectors"
import { log } from "@/lib/log"
import {
  createGatewayModel,
  fallbackModel,
  isProviderFailure,
  modelForTier,
  resolveTier,
} from "@/lib/models"
import { isSecretsConfigured } from "@/lib/secrets"
import { isWebConfigured } from "@/lib/web"

export type WorkerContext = {
  workerId: string
  leaseSeconds: number
  // Aborted when the worker shuts down
  shutdown: AbortSignal
}

type Hooks = Pick<
  Parameters<typeof streamText<ToolSet>>[0],
  "onLanguageModelCallEnd" | "onToolExecutionStart" | "onToolExecutionEnd"
>

type StopReason = "canceled" | "lease_lost" | "deadline" | "budget" | "shutdown"

const HEARTBEAT_MS = 5_000

// Added to the instructions for the last step a turn is allowed
const LAST_STEP = `

# Step limit reached
This is your last step in this task, and your tools are switched off. Tell the person what you have found or done so far, with the concrete details (names, numbers, links), and what is still left. They can reply to have you carry on.`

// Each member's own loop inside an `assign` call
const ASSIGNMENT_STEPS = 8
// The live view shows only the end of what a member has written so far
const PREVIEW_CHARS = 280
// What the lead gets back from each member, at most
const RESULT_CHARS = 12_000

// Every side-effect tool waits for the person's approval of the exact call,
// and so does any web request once private mail or documents are in context
const guardWeb = (_input: unknown, { messages }: { messages: ModelMessage[] }) =>
  privateContentSeen(messages) ? ("user-approval" as const) : undefined
const APPROVALS = {
  ...Object.fromEntries(
    [...SIDE_EFFECT_TOOLS].map((name) => [name, "user-approval" as const])
  ),
  web_search: guardWeb,
  web_fetch: guardWeb,
}

// Model errors that a stronger model is likely to get past
const QUALITY_ERRORS = new Set([
  "AI_NoSuchToolError",
  "AI_InvalidToolInputError",
  "AI_TypeValidationError",
  "AI_NoOutputGeneratedError",
  "AI_JSONParseError",
])

/* ──────────────────────────── stream out ────────────────────────── */

// Batches stream chunks into task_events rows, in order
class Publisher {
  private buffer: UIMessageChunk[] = []
  private seq = 0
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private task: Pick<Task, "id" | "userId">,
    private attempt: number
  ) {}

  push(chunk: UIMessageChunk) {
    this.buffer.push(chunk)
    if (this.buffer.length >= 64) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), 200)
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.buffer.length === 0) return this.chain
    const chunks = this.buffer
    this.buffer = []
    const seq = this.seq++
    this.chain = this.chain.then(() => this.write(seq, chunks))
    return this.chain
  }

  private async write(seq: number, chunks: UIMessageChunk[]) {
    const row = {
      taskId: this.task.id,
      userId: this.task.userId,
      attempt: this.attempt,
      seq,
      chunks,
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await privileged.insert(taskEvents).values(row).onConflictDoNothing()
        return
      } catch (error) {
        if (attempt === 2)
          log.error("task_events write failed", { taskId: this.task.id, error })
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
  }
}

/* ───────────────────────────── load ─────────────────────────────── */

async function loadContext(task: Task) {
  return withUser(task.userId, async (tx) => {
    const thread = await tx.query.threads.findFirst({
      where: eq(threads.id, task.threadId),
      with: {
        agent: true,
        squad: {
          with: {
            members: { orderBy: asc(squadMembers.position), with: { agent: true } },
          },
        },
      },
    })
    if (!thread) return null
    const members: Agent[] = thread.squad
      ? thread.squad.members.map((member) => member.agent)
      : thread.agent
        ? [thread.agent]
        : []
    const notes = new Map<string, MemoryNote[]>()
    if (members.length > 0) {
      const rows = await tx
        .select({
          id: memories.id,
          agentId: memories.agentId,
          content: memories.content,
          source: memories.source,
        })
        .from(memories)
        .where(
          inArray(
            memories.agentId,
            members.map((member) => member.id)
          )
        )
        .orderBy(asc(memories.createdAt))
      for (const row of rows)
        notes.set(row.agentId, [...(notes.get(row.agentId) ?? []), row])
    }
    const history = await loadMessages(tx, task.threadId)
    // What the person connected; tokens stay in lib/connectors.ts
    const accounts = isSecretsConfigured()
      ? await tx
          .select({ provider: connections.provider, scopes: connections.scopes })
          .from(connections)
      : []
    const connected: Connected = {
      google: googleServices(accounts.find((a) => a.provider === "google")?.scopes ?? []),
      notion: accounts.some((a) => a.provider === "notion"),
    }
    return { thread, members, notes, history, connected }
  })
}

/* ───────────────────────────── run ──────────────────────────────── */

export async function runTask(task: Task, ctx: WorkerContext) {
  const attempt = task.attempts
  const startedAt = Date.now()
  const controller = new AbortController()
  let stopReason: StopReason | null = null
  const stop = (reason: StopReason) => {
    if (stopReason) return
    stopReason = reason
    controller.abort(reason)
  }
  const onShutdown = () => stop("shutdown")
  ctx.shutdown.addEventListener("abort", onShutdown)

  const [plan] = await privileged.select().from(plans).where(eq(plans.id, task.planId))
  let modelId = task.model ?? (await modelForTier(task.tier))
  await privileged
    .insert(taskAttempts)
    .values({
      taskId: task.id,
      attempt,
      userId: task.userId,
      workerId: ctx.workerId,
      tier: task.tier,
      model: modelId,
    })
    .onConflictDoNothing()
  await privileged.update(tasks).set({ model: modelId }).where(eq(tasks.id, task.id))

  const heartbeat = setInterval(async () => {
    try {
      const result = await privileged.execute(
        sql`select * from kriya.heartbeat_task(${task.id}, ${ctx.workerId}, ${ctx.leaseSeconds})`
      )
      const row = rowsOf<{ cancel_requested: boolean }>(result)[0]
      if (!row) stop("lease_lost")
      else if (row.cancel_requested) stop("canceled")
    } catch (error) {
      log.warn("heartbeat failed", { taskId: task.id, error })
    }
  }, HEARTBEAT_MS)
  const timeLeft = Math.min(
    task.deadlineAt.getTime() - Date.now(),
    (plan?.maxTaskSeconds ?? 300) * 1000
  )
  const deadline = setTimeout(() => stop("deadline"), Math.max(0, timeLeft))

  let failure: unknown = null
  let reply: KriyaMessage | null = null
  let sideEffects = false
  const publisher = new Publisher(task, attempt)

  try {
    const context = await loadContext(task)
    if (!context) throw new Error("The thread for this task no longer exists.")
    const { thread, members, notes, history, connected } = context
    const first = members.find((member) => member.id === task.input.agentId) ?? members[0]
    if (!first) throw new Error("This thread has no agents left in it.")

    /* Delegation: whoever holds the turn owns the tools and the prompt */
    let current = first
    const held = [first.id]
    let brief: string | undefined
    const capabilities = { web: isWebConfigured(), connected, writes: true }
    const env: ToolEnv = {
      current: () => current,
      userId: task.userId,
      threadId: task.threadId,
    }
    const squadContext = (agent: Agent) =>
      thread.squad
        ? {
            squad: thread.squad as Squad,
            members,
            delegatedFrom: held.filter((id) => id !== agent.id),
            brief,
          }
        : undefined
    const instructionsFor = (agent: Agent) =>
      buildInstructions(
        agent,
        capabilities,
        notes.get(agent.id) ?? [],
        squadContext(agent)
      )

    let calls = 0
    let spentMicroUsd = 0
    let appliedAgentId = first.id
    // The model for each agent: its own tier, within what the plan allows
    const tierFor = async (agent: Agent): Promise<Tier> =>
      plan ? resolveTier(agent.model, plan) : task.tier
    const usageMetadata = { input: 0, output: 0 }
    // Metering, budget and tool records, shared by the lead and every member
    // working on an `assign` part: one task, one meter
    const hooks: Hooks = {
      onLanguageModelCallEnd: async (call) => {
        usageMetadata.input += call.usage.inputTokens ?? 0
        usageMetadata.output += call.usage.outputTokens ?? 0
        try {
          spentMicroUsd += await recordUsage({
            task,
            attempt,
            call: calls++,
            model: call.modelId ?? modelId,
            usage: call.usage,
            providerMetadata: call.providerMetadata,
            generationId: call.responseId,
            finishReason: call.finishReason,
            latencyMs: Math.round(call.performance.responseTimeMs),
          })
        } catch (error) {
          log.error("usage record failed", { taskId: task.id, error })
        }
        if (spentMicroUsd > task.costBudgetMicroUsd) stop("budget")
      },
      onToolExecutionStart: async ({ toolCall }) => {
        const sideEffect = SIDE_EFFECT_TOOLS.has(toolCall.toolName)
        if (sideEffect) sideEffects = true
        await privileged
          .insert(toolExecutions)
          .values({
            taskId: task.id,
            userId: task.userId,
            attempt,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            sideEffect,
            input: redactInput(toolCall.input),
          })
          .onConflictDoNothing()
          .catch((error) => log.error("tool record failed", { taskId: task.id, error }))
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput, toolExecutionMs }) => {
        const ok = toolOutput.type === "tool-result"
        await privileged
          .update(toolExecutions)
          .set({
            status: ok ? "succeeded" : "failed",
            outputSummary: ok ? summarize(toolOutput.output) : null,
            error: ok ? null : describeError(toolOutput.error),
            finishedAt: new Date(),
            durationMs: Math.round(toolExecutionMs),
          })
          .where(
            and(
              eq(toolExecutions.taskId, task.id),
              eq(toolExecutions.attempt, attempt),
              eq(toolExecutions.toolCallId, toolCall.toolCallId)
            )
          )
          .catch((error) => log.error("tool record failed", { taskId: task.id, error }))
      },
    }

    // Members working on parts of an `assign` call at the same time, each in
    // its own loop with its own tools, memory and model, under the task's
    // abort signal and meter. Yields a snapshot whenever something changes.
    const runAssignments: AssignRunner = async function* (assignments) {
      const lead = current
      const squadName = thread.squad?.name ?? "squad"
      const ask = history.findLast((m) => m.role === "user")
      const asked = ask ? textOf(ask) : ""
      const slots: Assignment[] = assignments.map(({ agentId, brief: part }) => {
        const agent = members.find((member) => member.id === agentId)
        if (!agent) throw new Error(`No agent in this squad has the id ${agentId}.`)
        if (agent.id === lead.id) {
          throw new Error("Assign parts to other members and do your own part yourself.")
        }
        return {
          agentId: agent.id,
          name: agent.name,
          glyph: agent.glyph,
          brief: part,
          status: "working",
          text: "",
          tools: [],
        }
      })
      if (new Set(slots.map((slot) => slot.agentId)).size !== slots.length) {
        throw new Error("Give each member one part.")
      }

      const work = slots.map(async (slot) => {
        const agent = members.find((member) => member.id === slot.agentId)!
        const memberEnv: ToolEnv = { ...env, current: () => agent }
        // No `assign` or `delegate`: members do their part themselves. No
        // connected accounts either: nobody can approve a member's web
        // request, so private data and the web never share its context.
        const memberTools: ToolSet = {
          ...createMemoryTools(memberEnv),
          ...(capabilities.web ? createWebTools() : {}),
        }
        try {
          const sub = streamText({
            ...hooks,
            model: createGatewayModel(await modelForTier(await tierFor(agent))),
            instructions: `${buildInstructions(agent, { ...capabilities, connected: { google: [], notion: false }, writes: false }, notes.get(agent.id) ?? [])}\n\n${assignmentBlock(lead, squadName)}`,
            prompt: `The person asked:\n${asked}\n\nYour part, from ${lead.name}:\n${slot.brief}`,
            tools: memberTools,
            stopWhen: isStepCount(ASSIGNMENT_STEPS),
            // The last step has to be a written result, not another tool call
            prepareStep: ({ stepNumber }) =>
              stepNumber === ASSIGNMENT_STEPS - 1 ? { toolChoice: "none" } : {},
            abortSignal: controller.signal,
            maxRetries: 2,
          })
          for await (const part of sub.stream) {
            if (part.type === "text-delta") slot.text += part.text
            else if (part.type === "start-step") slot.text = ""
            else if (part.type === "tool-call") slot.tools.push(part.toolName)
            else if (part.type === "error") throw part.error
          }
          slot.text = slot.text.trim().slice(0, RESULT_CHARS)
          slot.status = slot.text ? "done" : "failed"
          if (!slot.text) slot.error = `${agent.name} finished without a result.`
        } catch (error) {
          slot.status = "failed"
          slot.error = controller.signal.aborted ? "Stopped." : describeError(error)
        }
      })

      let settled = false
      const all = Promise.all(work).then(() => {
        settled = true
      })
      const snapshot = (final: boolean) =>
        slots.map((slot) => ({
          ...slot,
          tools: [...slot.tools],
          text: final ? slot.text : slot.text.slice(-PREVIEW_CHARS),
        }))
      const fingerprint = () =>
        slots.map((s) => `${s.status}:${s.tools.length}:${s.text.length}`).join("|")
      let last = ""
      while (!settled) {
        const now = fingerprint()
        if (now !== last) {
          last = now
          yield snapshot(false)
        }
        await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 1_000))])
      }
      yield snapshot(true)
    }

    const tools: ToolSet = {
      ...createMemoryTools(env),
      ...(capabilities.web ? createWebTools() : {}),
      ...createConnectorTools(env, connected, { writes: true }),
      ...(thread.squad ? createAssignTool(runAssignments) : {}),
      ...(thread.squad
        ? createDelegateTool((targetId, handoverBrief) => {
            const target = members.find((member) => member.id === targetId)
            if (!target) throw new Error("No agent in this squad has that id.")
            if (held.includes(target.id)) {
              throw new Error(
                `${target.name} already had this request. Handle it yourself.`
              )
            }
            current = target
            held.push(target.id)
            brief = handoverBrief
            return { agentId: target.id, name: target.name }
          })
        : {}),
    }

    const result = streamText({
      model: createGatewayModel(modelId),
      instructions: instructionsFor(first),
      messages: await convertToModelMessages(history, {
        tools,
        ignoreIncompleteToolCalls: true,
      }),
      tools,
      toolApproval: APPROVALS,
      stopWhen: isStepCount(task.stepBudget),
      abortSignal: controller.signal,
      maxRetries: 2,
      prepareStep: async ({ messages: stepMessages, stepNumber }) => {
        const compacted = compactContext(stepMessages)
        const lastStep = stepNumber === task.stepBudget - 1
        const delegated = current.id !== appliedAgentId
        if (!delegated && !lastStep) return { messages: compacted }
        appliedAgentId = current.id
        if (delegated && current.model !== first.model) {
          modelId = await modelForTier(await tierFor(current))
        }
        return {
          messages: compacted,
          ...(delegated && { model: createGatewayModel(modelId) }),
          instructions: instructionsFor(current) + (lastStep ? LAST_STEP : ""),
          ...(lastStep && { toolChoice: "none" as const }),
        }
      },
      ...hooks,
      onError: ({ error }) => {
        failure = error
      },
    })

    let ended: (message: KriyaMessage) => void = () => {}
    const endedPromise = new Promise<KriyaMessage>((resolve) => (ended = resolve))
    const stream = toUIMessageStream<ToolSet, KriyaMessage>({
      stream: result.stream,
      originalMessages: history,
      generateMessageId: () => nanoid(),
      messageMetadata: ({ part }) => {
        const base = { agentId: first.id, tier: task.tier, taskId: task.id }
        if (part.type === "start") return base
        if (part.type === "finish") {
          return {
            ...base,
            usage: { ...usageMetadata },
            durationMs: Date.now() - startedAt,
          }
        }
        return undefined
      },
      onError: (error) => describeError(error),
      onEnd: ({ responseMessage }) => ended(responseMessage),
    })

    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      publisher.push(value)
    }
    reply = await Promise.race([
      endedPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ])
  } catch (error) {
    failure ??= error
  } finally {
    clearInterval(heartbeat)
    clearTimeout(deadline)
    ctx.shutdown.removeEventListener("abort", onShutdown)
  }

  // Lost the lease, or the worker is stopping: leave the task to recovery,
  // which requeues it (or fails it if something irreversible already ran)
  if (stopReason === "lease_lost" || stopReason === "shutdown") {
    await publisher.flush()
    await privileged
      .update(tasks)
      .set({ leaseExpiresAt: new Date(0) })
      .where(and(eq(tasks.id, task.id), eq(tasks.leaseOwner, ctx.workerId)))
    log.info("task released", { taskId: task.id, reason: stopReason })
    return
  }

  /* ─────────────────────────── settle ─────────────────────────── */

  const errorName = (failure as { name?: string } | null)?.name ?? ""
  const retriesLeft = attempt < task.maxAttempts && Date.now() < task.deadlineAt.getTime()
  const fallback = await fallbackModel()
  let retry: { model: string | null; tier: Tier } | null = null
  if (failure && !stopReason && retriesLeft && !sideEffects) {
    if (isProviderFailure(failure)) {
      retry = {
        model: fallback && fallback !== modelId ? fallback : modelId,
        tier: task.tier,
      }
    } else if (
      QUALITY_ERRORS.has(errorName) &&
      task.tier !== "escalation" &&
      plan?.allowedTiers.includes("escalation")
    ) {
      retry = { model: null, tier: "escalation" }
    }
  }

  if (retry) {
    publisher.push({ type: "error", errorText: "Retrying this task…" })
    await publisher.flush()
    await privileged
      .update(taskAttempts)
      .set({
        status: "failed",
        errorCode: "retry",
        error: describeError(failure),
        finishedAt: new Date(),
      })
      .where(and(eq(taskAttempts.taskId, task.id), eq(taskAttempts.attempt, attempt)))
    await privileged
      .update(tasks)
      .set({
        status: "queued",
        tier: retry.tier,
        model: retry.model,
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: new Date(Date.now() + 2_000 * 2 ** attempt),
        errorCode: "retrying",
        error: describeError(failure),
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.leaseOwner, ctx.workerId)))
    log.warn("task retrying", {
      taskId: task.id,
      attempt,
      error: errorName,
      model: modelId,
    })
    return
  }

  const outcome: {
    status: "succeeded" | "failed" | "canceled"
    code: string | null
    error: string | null
  } =
    stopReason === "canceled"
      ? { status: "canceled", code: "canceled", error: null }
      : stopReason === "deadline"
        ? { status: "failed", code: "deadline", error: "The task ran out of time." }
        : stopReason === "budget"
          ? {
              status: "failed",
              code: "budget",
              error: "The task reached its spending limit.",
            }
          : failure
            ? {
                status: "failed",
                code: errorName || "error",
                error: describeError(failure),
              }
            : { status: "succeeded", code: null, error: null }

  // An abort ends the stream quietly; say why
  if (stopReason === "deadline" || stopReason === "budget") {
    publisher.push({ type: "error", errorText: outcome.error ?? "The task stopped." })
  }
  await publisher.flush()

  if (reply && reply.parts.length > 0) {
    const saved = reply
    await withUser(task.userId, async (tx) => {
      await saveMessage(tx, task.userId, task.threadId, saved)
      const preview = previewOf(saved)
      await tx
        .update(threads)
        .set({ activeAt: new Date(), ...(preview && { preview: preview.slice(0, 140) }) })
        .where(eq(threads.id, task.threadId))
    }).catch((error) => log.error("reply save failed", { taskId: task.id, error }))
  }

  await chargeTask(task).catch((error) =>
    log.error("charge failed", { taskId: task.id, error })
  )
  await privileged
    .update(taskAttempts)
    .set({
      status: outcome.status,
      errorCode: outcome.code,
      error: outcome.error,
      finishedAt: new Date(),
    })
    .where(and(eq(taskAttempts.taskId, task.id), eq(taskAttempts.attempt, attempt)))
  await privileged
    .update(tasks)
    .set({
      status: outcome.status,
      errorCode: outcome.code,
      error: outcome.error,
      finishedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.leaseOwner, ctx.workerId)))

  log.info("task finished", {
    taskId: task.id,
    status: outcome.status,
    code: outcome.code,
    model: modelId,
    attempt,
    ms: Date.now() - startedAt,
  })
}

// Tool inputs are kept as evidence, minus anything that looks like a secret
function redactInput(input: unknown) {
  const text = JSON.stringify(input ?? null)
  if (text.length > 4_000) return { truncated: text.slice(0, 4_000) }
  return JSON.parse(
    text.replace(
      /("(?:password|token|secret|otp|cvv|card)[^"]*"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"'
    )
  )
}

function summarize(output: unknown) {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}
