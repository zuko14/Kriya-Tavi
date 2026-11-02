import {
  convertToModelMessages,
  type ModelMessage,
  isStepCount,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type UIMessageChunk,
} from "ai"
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, rowsOf, withUser, type Tx } from "@/db"
import {
  connections,
  memories,
  messages,
  plans,
  profiles,
  squadMembers,
  taskAttempts,
  taskEvents,
  tasks,
  threadSummaries,
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
  buildInstructionsV2,
  type MemoryContext,
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
import { recordApprovals, redactInput } from "@/lib/agent/approvals"
import { writeEpisode } from "@/lib/agent/episodes"
import { chargeTask, recordUsage } from "@/lib/agent/metering"
import {
  CAPABILITIES,
  disabledTools,
  isIdempotentRead,
  unclassifiedTools,
} from "@/lib/agent/capabilities"
import { approvalFor, classifyTool, TOOL_CLASSES } from "@/lib/agent/policy"
import { verificationOf } from "@/lib/agent/verify"
import {
  createAssignTool,
  createBrowserTools,
  createConnectorTools,
  createCrewTools,
  createFileTools,
  createGoogleV2Tools,
  createKitTools,
  createDelegateTool,
  createGoalTools,
  createMemoryTools,
  createMemoryToolsV2,
  createLedgerTools,
  createMandateTools,
  createMcpTools,
  createProposeCallTool,
  createRadarTools,
  createRoomTools,
  createSkillTools,
  createWebTools,
  createWorkspaceTools,
  SIDE_EFFECT_TOOLS,
  type Assignment,
  type AssignRunner,
  privateContentSeen,
  type Connected,
  type KriyaMessage,
  type McpTask,
  type ToolEnv,
} from "@/lib/agent/tools"
import { browserProvider, TaskBrowser } from "@/lib/browser/session"
import { cloudSettings, TaskWorkspace, workspaceProvider } from "@/lib/cloud/session"
import { withCloudCoding } from "@/lib/cloud/skill"
import { getSetting } from "@/lib/config"
import { agentGlyph } from "@/lib/glyph"
import { BASELINE_POLICY, bundleFor, stampTask, type Policy } from "@/lib/improve"
import { EXTRA_GOOGLE_SERVICES, googleServices } from "@/lib/connectors"
import { log } from "@/lib/log"
import { definitionShare } from "@/lib/delivery/cost"
import { loadMcp } from "@/lib/mcp/registry"
import { jobOfThread } from "@/lib/operator/crews"
import { activeGrants, consumeGrant, withGrants } from "@/lib/operator/grants"
import { rerankByMeaning } from "@/lib/memory/embed"
import {
  embeddingModel,
  enqueueEmbedding,
  enqueueSummary,
  withinCap,
} from "@/lib/memory/maintenance"
import { alwaysOnNotes, recallNotes } from "@/lib/memory/retrieve"
import { renderSummary } from "@/lib/memory/summaries"
import { roomOfTask } from "@/lib/rooms/agents"
import { requestOf } from "@/lib/rooms/context"
import { relayToRoom } from "@/lib/rooms/relay"
import {
  createGatewayModel,
  fallbackModel,
  isProviderFailure,
  modelForTier,
  resolveTier,
} from "@/lib/models"
import { wrapReads } from "@/lib/reliability/retry"
import { isSecretsConfigured } from "@/lib/secrets"
import { readSkill, recordActivations, settleActivations } from "@/lib/skill-engine"
import {
  CATALOG,
  CATALOG_V2,
  parsePins,
  parseSkillList,
  resolveSkills,
  skillsBlock,
  type Resolution,
} from "@/lib/skill-library"
import { personalCatalog } from "@/lib/skill-studio"
import { PERSONAL_ID } from "@/lib/skill-studio/design"
import { loadSkillV2 } from "@/lib/skills-v2"
import { undoColumns } from "@/lib/undo"
import { voiceAvailable } from "@/lib/voice/tasks"
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

// Every tool lib/agent/policy.ts puts at R2–R4 waits for the person's
// approval of the exact call, and so does any web request once private mail
// or documents are in context
const guardWeb = (_input: unknown, { messages }: { messages: ModelMessage[] }) =>
  privateContentSeen(messages) ? ("user-approval" as const) : undefined
const needsApproval = (name: string, input: unknown) =>
  approvalFor(classifyTool(name, input)) === "user-approval"
export const TOOL_APPROVALS = {
  ...Object.fromEntries(
    Object.keys(TOOL_CLASSES)
      .filter((name) => needsApproval(name, {}))
      .map((name) => [name, "user-approval" as const])
  ),
  // A new rule waits; pausing or ending doesn't
  schedule_update: (input: unknown) =>
    needsApproval("schedule_update", input) ? ("user-approval" as const) : undefined,
  web_search: guardWeb,
  web_fetch: guardWeb,
  browser_open: guardWeb,
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

// Memory v2 notes for each agent that may hold the turn: the always-on
// blocks plus the notes that best match the person's latest message. How
// many candidates and their weights come from the policy bundle (A12).
async function loadMemoryV2(
  tx: Tx,
  task: Task,
  members: Agent[],
  history: KriyaMessage[],
  summary: string | null,
  policy: Policy
) {
  const ask = history.findLast((message) => message.role === "user")
  const query = ask ? textOf(ask) : ""
  const [profile] = await tx
    .select({ locale: profiles.locale })
    .from(profiles)
    .where(eq(profiles.id, task.userId))
  const memory = new Map<string, Omit<MemoryContext, "now">>()
  for (const member of members) {
    const scope = { userId: task.userId, agentId: member.id }
    const always = await alwaysOnNotes(tx, scope)
    const recalled = await recallNotes(tx, {
      ...scope,
      query,
      limit: policy.bundle.budgets.recallCandidates,
      weights: policy.bundle.retrieval,
      exclude: [...always.profile, ...always.standing].map((note) => note.id),
    })
    memory.set(member.id, {
      ...always,
      recalled,
      summary,
      locale: profile?.locale ?? "en-IN",
    })
  }
  return memory
}

// The thread's latest summary checkpoint and the messages it stands in for:
// those leave the model's input (the person still sees them)
async function loadCheckpoint(tx: Tx, threadId: string) {
  const [latest] = await tx
    .select()
    .from(threadSummaries)
    .where(eq(threadSummaries.threadId, threadId))
    .orderBy(desc(threadSummaries.coversThrough))
    .limit(1)
  if (!latest) return { summary: null, covered: new Set<string>() }
  const rows = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(eq(messages.threadId, threadId), lte(messages.createdAt, latest.coversThrough))
    )
  return {
    summary: renderSummary(latest.summary),
    covered: new Set(rows.map((row) => row.id)),
  }
}

async function loadContext(
  task: Task,
  memoryV2: boolean,
  connectorsV2 = false,
  policy = BASELINE_POLICY,
  sheetsOn = false
) {
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
    if (members.length > 0 && !memoryV2) {
      const rows = await tx
        .select({
          id: memories.id,
          agentId: memories.agentId,
          content: memories.content,
          source: memories.source,
        })
        .from(memories)
        .where(
          and(
            inArray(
              memories.agentId,
              members.map((member) => member.id)
            ),
            // Superseded, forgotten and archived notes are history, not memory
            isNull(memories.invalidAt),
            eq(memories.archived, false)
          )
        )
        .orderBy(asc(memories.createdAt))
      // inArray leaves out shared notes, so agentId is set
      for (const row of rows)
        notes.set(row.agentId!, [...(notes.get(row.agentId!) ?? []), row])
    }
    const history = await loadMessages(tx, task.threadId)
    const checkpoint = memoryV2
      ? await loadCheckpoint(tx, task.threadId)
      : { summary: null, covered: new Set<string>() }
    const memory = memoryV2
      ? await loadMemoryV2(tx, task, members, history, checkpoint.summary, policy)
      : new Map<string, Omit<MemoryContext, "now">>()
    // What the person connected; tokens stay in lib/connectors.ts
    const accounts = isSecretsConfigured()
      ? await tx
          .select({ provider: connections.provider, scopes: connections.scopes })
          .from(connections)
      : []
    const connected: Connected = {
      google: googleServices(
        accounts.find((a) => a.provider === "google")?.scopes ?? []
      ).filter(
        (service) =>
          connectorsV2 ||
          (sheetsOn && service === "sheets") ||
          !EXTRA_GOOGLE_SERVICES.includes(service)
      ),
      notion: accounts.some((a) => a.provider === "notion"),
      // A8: absent, not false, with the switch off (prompt byte-identical)
      ...(connectorsV2 && {
        github: accounts.some((a) => a.provider === "github"),
        meta: accounts.some((a) => a.provider === "meta"),
      }),
    }
    return {
      thread,
      members,
      notes,
      memory,
      history,
      covered: checkpoint.covered,
      connected,
    }
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
  // Read once, so a task never mixes the two memory systems
  const memoryV2 = (await getSetting("agents.memoryV2")) === "on"
  // A12: the policy bundle, read once per task; off = the code baseline,
  // unstamped, exactly as before
  const improvement = (await getSetting("agents.improvement")) === "on"
  const policy = improvement ? await bundleFor(task.userId) : BASELINE_POLICY
  // Notes put in front of the model this task (memory v2)
  const usedMemories = new Set<string>()
  // A3: the Inbox and "What I did"; goal and schedule tools
  const inbox = (await getSetting("agents.inbox")) === "on"
  const goalTools = (await getSetting("agents.goals")) === "on"
  // A8: GitHub, Sheets, YouTube and Instagram tools; the Undo window (K3)
  const connectorsV2 = (await getSetting("agents.connectors")) === "on"
  // Sheets alone, without the other A8 connectors
  const sheetsOn = (await getSetting("google.sheets")) === "on"
  const undo = (await getSetting("agents.undo")) === "on"
  const skillTools = (await getSetting("agents.skills")) === "on"
  // Track C: this thread's cloud workspace (cloud.workspaces, the plan's
  // minutes, a configured provider); off reads nothing else of track C
  const workspaceAdapter =
    (await getSetting("cloud.workspaces")) === "on" && (plan?.workspaceMinutes ?? 0) > 0
      ? await workspaceProvider()
      : null
  const workspace = workspaceAdapter
    ? new TaskWorkspace(workspaceAdapter, task, await cloudSettings())
    : null
  // Skill library (SKILLS_ENGINE.md): instruction packs for this task; off
  // leaves the prompt exactly as before
  const skillLibrary =
    (await getSetting("agents.skillLibrary")) === "on"
      ? {
          disabled: parseSkillList(await getSetting("skills.disabled")),
          pins: parsePins(await getSetting("skills.pins")),
          // N8: Unicode matching and the v2 skills, only with the switch on
          ...((await getSetting("next.skillsV2")) === "on" && {
            catalog: CATALOG_V2,
            unicode: true,
            load: loadSkillV2,
          }),
        }
      : null
  // Skill Studio: the person's approved skills join the catalogue. A failed
  // read means none of them, never a failed task; off changes nothing
  if (skillLibrary && (await getSetting("next.skillStudio")) === "on") {
    const personal = await personalCatalog(task.userId).catch((error) => {
      log.error("personal skills failed", { taskId: task.id, error })
      return null
    })
    if (personal?.manifests.length) {
      const load = skillLibrary.load ?? readSkill
      Object.assign(skillLibrary, {
        // First in the catalogue: among skills picked the same way, one the
        // person approved for this agent comes before a library default
        // (required safeguards still lead, by mode). Found on a real task,
        // where library skills filled the budget first (2026-10-30).
        catalog: [...personal.manifests, ...(skillLibrary.catalog ?? CATALOG)],
        load: (id: string, version: string) =>
          PERSONAL_ID.test(id) ? personal.load(id, version) : load(id, version),
      })
    }
  }
  // CD-20: a workspace turn gets cloud-coding in place of code-assistance
  if (skillLibrary && workspace)
    Object.assign(skillLibrary, withCloudCoding(skillLibrary))
  // A7: ledger tools need the switch and a plan with the ledger
  const ledgerTools =
    (await getSetting("agents.ledger")) === "on" && Boolean(plan?.ledgerEnabled)
  // A13: watchers (inside schedule_create), Radar and facts tools
  const watchers = (await getSetting("agents.watchers")) === "on"
  const radar = (await getSetting("agents.radar")) === "on"
  const facts = (await getSetting("agents.facts")) === "on"
  // Voice phase 4: propose_call and its prompt line, with voice access only (F4, F5)
  const voice = await voiceAvailable(task.userId)
  // The agent browser (A4): switch on, plan minutes, kriya-browser configured
  const provider =
    (await getSetting("agents.browser")) === "on" && (plan?.browserMinutes ?? 0) > 0
      ? browserProvider()
      : null
  // A6: saved sign-ins (agents.loginProfiles) and kits (K9, agents.kits)
  const loginProfiles = (await getSetting("agents.loginProfiles")) === "on"
  const kitTools = (await getSetting("agents.kits")) === "on"
  // O1: tools the owner switched off for everyone (empty: none)
  const disabled = disabledTools(await getSetting("operator.disabledTools"))
  // O3: jobs, which live on goals and are proven by "What I did" (OD-21)
  const mandates = (await getSetting("operator.mandates")) === "on" && goalTools && inbox
  // O5: Kriya's verdict on a job, from records
  const reports = mandates && (await getSetting("operator.reports")) === "on"
  // O4: standing grants answer a matching call's approval (OD-02)
  const grantsOn = mandates && (await getSetting("operator.grants")) === "on"
  // O11: a job's squad lead may hand parts to members who act (OD-19)
  const crews = mandates && (await getSetting("operator.crews")) === "on"
  // A5: file_read, the text extracted from the person's files
  const fileTools = (await getSetting("agents.files")) === "on"
  // G2: Drive import and sharing, sending a saved draft (OD-15/16/17)
  const google2 = {
    driveShare: (await getSetting("operator.driveShare")) === "on",
    gmailSend: (await getSetting("operator.gmailSend")) === "on",
    calendarDelete: (await getSetting("operator.calendarDelete")) === "on",
  }
  // N4: retries and a circuit breaker for reads that are safe to repeat (ND-05)
  const reliable = (await getSetting("next.reliability")) === "on"
  // N5: owner-pinned app tools (ND-06); needs agents.inbox so they reach "What I did"
  const mcpOn = inbox && (await getSetting("next.mcp")) === "on"
  // N9: recalled notes reordered by meaning (ND-15); needs memory v2, a model,
  // and room under the person's maintenance cap
  const embedModel = memoryV2 ? await embeddingModel() : null
  const rerankModel = embedModel && (await withinCap(task.userId)) ? embedModel : null
  const browser = provider
    ? new TaskBrowser(provider, task, { profiles: loginProfiles })
    : null
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
  if (improvement) await stampTask(task.id, policy)

  const heartbeat = setInterval(async () => {
    try {
      const result = await privileged.execute(
        sql`select * from kriya.heartbeat_task(${task.id}, ${ctx.workerId}, ${ctx.leaseSeconds})`
      )
      const row = rowsOf<{ cancel_requested: boolean }>(result)[0]
      if (!row) stop("lease_lost")
      else if (row.cancel_requested) stop("canceled")
      else {
        await browser?.heartbeat()
        await workspace?.heartbeat()
      }
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
  // Tool calls a grant answered, for their tool_executions row
  const granted = new Map<string, string>()
  // What the skill library loaded for each agent that held the turn
  const skillsUsed = new Map<string, Resolution>()
  const skillRecords: Promise<void>[] = []
  let mcp: McpTask | null = null

  try {
    const context = await loadContext(task, memoryV2, connectorsV2, policy, sheetsOn)
    if (!context) throw new Error("The thread for this task no longer exists.")
    const { thread, members, notes, memory, history, covered } = context
    // Track R (RD-05, RD-07): a room request's belt and prompt. An agent
    // since removed from the room keeps the room's limits, without its history
    const room =
      task.input.channel === "room"
        ? ((await roomOfTask(task).catch((error) => {
            log.error("room read failed", { taskId: task.id, error })
            return null
          })) ?? { roomId: null, title: "a room", allowConnectors: false })
        : null
    // No connected accounts or apps in a room unless the owner allowed them
    const roomLocked = room !== null && !room.allowConnectors
    const connected: Connected = roomLocked
      ? { google: [], notion: false }
      : context.connected
    // The owner's memory is private like their accounts (owner, 2026-11-01):
    // a locked room task sees none of it
    if (roomLocked) {
      notes.clear()
      for (const [id, held] of memory)
        memory.set(id, { ...held, profile: [], standing: [], recalled: [] })
    }
    // N9: each agent's recalled candidates reordered by meaning, outside the
    // person's transaction (one embedding of their message); a failure keeps
    // today's order
    if (rerankModel && memory.size > 0 && !roomLocked) {
      const ask = history.findLast((message) => message.role === "user")
      const entries = [...memory.entries()]
      const lists = await rerankByMeaning(
        { userId: task.userId, model: rerankModel, query: ask ? textOf(ask) : "" },
        entries.map(([, context]) => context.recalled)
      )
      entries.forEach(([id, context], i) =>
        memory.set(id, { ...context, recalled: lists[i] })
      )
    }
    const first = members.find((member) => member.id === task.input.agentId) ?? members[0]
    if (!first) throw new Error("This thread has no agents left in it.")
    // Apps the person turned on for this agent; a failure means no apps, never a failed task
    if (mcpOn && !roomLocked) {
      mcp = await loadMcp(task, first.id, {
        maxTools: Number(await getSetting("next.mcpMaxTools")),
        disabled,
      }).catch((error) => {
        log.error("mcp load failed", { taskId: task.id, error })
        return null
      })
    }

    /* Delegation: whoever holds the turn owns the tools and the prompt */
    let current = first
    const held = [first.id]
    let brief: string | undefined
    const capabilities = {
      web: isWebConfigured(),
      connected,
      writes: true,
      // Absent, not false, with the switch off: the prompt stays byte-identical
      ...(inbox && { citations: true }),
      ...(voice && { voice: true }),
      ...(mandates && { mandates: true }),
      ...(mcp && { apps: { names: mcp.apps, notes: mcp.notes } }),
      ...(workspace && {
        workspace: { line: await workspace.describe().catch(() => null) },
      }),
      ...(room && { room: { title: room.title, accounts: !roomLocked } }),
    }
    const env: ToolEnv = {
      current: () => current,
      userId: task.userId,
      threadId: task.threadId,
      taskId: task.id,
    }
    const memoryTools = memoryV2 ? createMemoryToolsV2 : createMemoryTools
    const crewJob =
      crews && thread.squad
        ? await jobOfThread(task.userId, task.threadId).catch((error) => {
            log.error("crew job read failed", { taskId: task.id, error })
            return null
          })
        : null
    const squadContext = (agent: Agent) =>
      thread.squad
        ? {
            squad: thread.squad as Squad,
            members,
            delegatedFrom: held.filter((id) => id !== agent.id),
            brief,
          }
        : undefined
    const promptFor = (
      agent: Agent,
      caps: typeof capabilities,
      squad?: ReturnType<typeof squadContext>
    ) => {
      const guidance = policy.bundle.prompts.saveGuidance
      if (!memoryV2)
        return buildInstructions(agent, caps, notes.get(agent.id) ?? [], squad, guidance)
      const v2 = buildInstructionsV2(
        agent,
        caps,
        { ...memory.get(agent.id)!, now: new Date() },
        squad,
        guidance
      )
      for (const id of v2.memoryIds) usedMemories.add(id)
      return v2.text
    }
    const instructionsFor = (agent: Agent) =>
      promptFor(agent, capabilities, squadContext(agent)) + skillsFor(agent)

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
        const sideEffect =
          SIDE_EFFECT_TOOLS.has(toolCall.toolName) ||
          (mcp?.sideEffects.has(toolCall.toolName) ?? false)
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
            grantId: granted.get(toolCall.toolCallId) ?? null,
            // ND-22: only MCP runs carry their class
            ...(mcp && { risk: mcp.classes.get(toolCall.toolName) ?? null }),
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
            // Whole, in its own column: the summary above is cut (AF-10)
            verification: ok ? verificationOf(toolOutput.output) : null,
            // How to reverse it, for 10 minutes (K3)
            ...(undo && ok && undoColumns(toolCall.toolName, toolOutput.output)),
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
          glyph: agentGlyph(agent),
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
          ...memoryTools(memberEnv),
          ...(capabilities.web ? createWebTools() : {}),
        }
        for (const name of disabled) delete memberTools[name]
        try {
          const sub = streamText({
            ...hooks,
            model: createGatewayModel(await modelForTier(await tierFor(agent))),
            instructions: `${promptFor(agent, { ...capabilities, connected: { google: [], notion: false }, writes: false })}\n\n${assignmentBlock(lead, squadName)}`,
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
      ...memoryTools(env),
      ...(capabilities.web ? createWebTools() : {}),
      ...(browser ? createBrowserTools(browser) : {}),
      // A repository needs GitHub connected; publishing also cloud.publish
      ...(workspace
        ? createWorkspaceTools(workspace, {
            repos: Boolean(connected.github),
            publish: (await getSetting("cloud.publish")) === "on",
          })
        : {}),
      ...(kitTools ? createKitTools(env, browser) : {}),
      ...createConnectorTools(env, connected, { writes: true }),
      ...(fileTools ? createFileTools(env, connected) : {}),
      ...(google2.driveShare || google2.gmailSend || google2.calendarDelete
        ? createGoogleV2Tools(env, connected, google2)
        : {}),
      ...(goalTools ? createGoalTools(env, { watchers }) : {}),
      ...(radar || facts ? createRadarTools(env, { radar, facts }) : {}),
      // A9: replay reaches the rest of this belt, so it can do no more than it
      ...(skillTools ? createSkillTools(env, () => tools, browser) : {}),
      ...(ledgerTools ? createLedgerTools(env) : {}),
      ...(voice ? createProposeCallTool(env) : {}),
      ...(mandates ? createMandateTools(env, { reports }) : {}),
      ...(crewJob ? createCrewTools(env) : {}),
      ...(mcp ? createMcpTools(mcp) : {}),
      ...(room?.roomId ? createRoomTools(env, room.roomId) : {}),
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
    // Skill replay reads this same belt, so a killed tool is gone there too.
    // shortcut: the prompt may still describe a killed tool's ability; pass
    // the list into Capabilities if owners start killing connector tools.
    for (const name of disabled) delete tools[name]
    // Track R: members' words never change or delete the owner's notes, and
    // a locked room task can't search them (new notes stay unconfirmed)
    if (room) {
      delete tools.memory_update
      delete tools.memory_forget
      if (roomLocked) delete tools.memory_search
    }
    // ND-21: no tool runs without a class (removes nothing today)
    for (const name of unclassifiedTools(Object.keys(tools), mcp?.classes)) {
      delete tools[name]
      log.warn("unclassified tool removed", { taskId: task.id, tool: name })
    }
    if (reliable)
      wrapReads(
        tools,
        (name) =>
          // An app's circuit is its own, the same key the registry checks
          name.startsWith("mcp_")
            ? `mcp:${name.split("_")[1]}`
            : (CAPABILITIES[name]?.system ?? "kriya"),
        (name) => isIdempotentRead(name) || (mcp?.idempotent.has(name) ?? false)
      )
    // NM7 (N10): the app share of the tool definitions, a number in the log
    if (mcp)
      await definitionShare(tools, mcp.classes.keys())
        .then((nm7) => log.info("tool definitions", { taskId: task.id, ...nm7 }))
        .catch(() => {})

    // Resolved once per agent that holds the turn, from the person's latest
    // message and this final belt: text only, never a tool. A failure means
    // no skills, never a failed task.
    // Only the person's words: a crew's join and briefs carry members'
    // reports, and a watcher run appends the page's diff after the person's
    // prompt (lib/watch.ts watchPrompt), so neither can pick a skill; a
    // room request quotes the room before the request (track R, RT-INV-06)
    const asked = history.findLast((m) => m.role === "user")
    const ask =
      !asked || asked.metadata?.channel === "crew"
        ? ""
        : asked.metadata?.channel === "room"
          ? // The raw text: textOf flattens the marker's line breaks
            requestOf(
              asked.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")
            )
          : textOf(asked).split("The watched page changed:")[0]
    const skillsFor = (agent: Agent) => {
      if (!skillLibrary) return ""
      let resolved = skillsUsed.get(agent.id)
      if (!resolved) {
        try {
          resolved = resolveSkills({
            prefs: agent.skills,
            role: agent.role,
            ask,
            tools: Object.keys(tools),
            load: readSkill,
            ...skillLibrary,
          })
        } catch (error) {
          log.error("skill resolution failed", { taskId: task.id, error })
          resolved = { active: [], skipped: [] }
        }
        skillsUsed.set(agent.id, resolved)
        skillRecords.push(
          recordActivations(task, attempt, agent.id, resolved).catch((error) =>
            log.error("skill record failed", { taskId: task.id, error })
          )
        )
      }
      return skillsBlock(resolved.active)
    }

    // Only the active job's own thread has grants; none (or a failed read)
    // passes today's map itself, so everything asks as before
    const jobGrants = grantsOn
      ? await activeGrants(task.userId, task.threadId).catch((error) => {
          log.error("grants read failed", { taskId: task.id, error })
          return []
        })
      : []
    // Today's map itself unless app tools are on the belt
    const approvalMap = mcp ? { ...TOOL_APPROVALS, ...mcp.approvals } : TOOL_APPROVALS
    const toolApproval = jobGrants.length
      ? withGrants(approvalMap, jobGrants, async (grantId, toolCallId) => {
          const ok = await consumeGrant(task.userId, grantId, task.id, toolCallId)
          if (ok) granted.set(toolCallId, grantId)
          return ok
        })
      : approvalMap

    const result = streamText({
      model: createGatewayModel(modelId),
      instructions: instructionsFor(first),
      messages: await convertToModelMessages(
        covered.size > 0
          ? history.filter((message) => !covered.has(message.id))
          : history,
        {
          tools,
          ignoreIncompleteToolCalls: true,
        }
      ),
      tools,
      toolApproval,
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
        const base = {
          agentId: first.id,
          tier: task.tier,
          taskId: task.id,
          ...(improvement && { policy: { version: policy.id, hash: policy.hash } }),
        }
        if (part.type === "start") return base
        if (part.type === "finish") {
          return {
            ...base,
            usage: { ...usageMetadata },
            durationMs: Date.now() - startedAt,
            ...(memoryV2 && { memoryIds: [...usedMemories] }),
            ...(skillsUsed.size > 0 && { skills: skillsMetadata(skillsUsed) }),
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
    await browser
      ?.close()
      .catch((error) => log.error("browser close failed", { taskId: task.id, error }))
    await workspace
      ?.close(stopReason)
      .catch((error) => log.error("workspace close failed", { taskId: task.id, error }))
    await mcp?.close()
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

  // One batched update for every note the model was shown (memory v2 §5.2)
  if (usedMemories.size > 0) {
    await withUser(task.userId, (tx) =>
      tx
        .update(memories)
        .set({ lastUsedAt: sql`now()`, useCount: sql`${memories.useCount} + 1` })
        .where(inArray(memories.id, [...usedMemories]))
    ).catch((error) =>
      log.error("memory usage update failed", { taskId: task.id, error })
    )
  }
  // A long thread gets a summary checkpoint in the background, never as a
  // task (AF-12)
  if (memoryV2) {
    await enqueueSummary(task.userId, task.threadId).catch((error) =>
      log.error("summary enqueue failed", { taskId: task.id, error })
    )
  }
  // N9: vectors for new or changed confirmed notes, in the background
  if (embedModel) {
    await enqueueEmbedding(task.userId).catch((error) =>
      log.error("embedding enqueue failed", { taskId: task.id, error })
    )
  }

  // The Inbox and "What I did" (A3): what the reply waits on, and a record
  // of what the task did, derived from its tool runs
  if (inbox) {
    const ref = { taskId: task.id }
    if (reply) {
      await recordApprovals({ ...task, reply }).catch((error) =>
        log.error("approvals index failed", { ...ref, error })
      )
    }
    await writeEpisode({
      userId: task.userId,
      taskId: task.id,
      threadId: task.threadId,
      agentId: task.agentId,
      reply,
    }).catch((error) => log.error("episode write failed", { ...ref, error }))
  }

  await chargeTask(task).catch((error) =>
    log.error("charge failed", { taskId: task.id, error })
  )
  if (skillsUsed.size > 0) {
    await Promise.all(skillRecords)
    await settleActivations(task, attempt, outcome.status).catch((error) =>
      log.error("skill outcome failed", { taskId: task.id, error })
    )
  }
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

  // Track R (RD-06): a room request's reply, or its approval's continuation,
  // reaches the room through the disclosure gate; never fails the task
  if (task.input.channel === "room" || task.idempotencyKey?.startsWith("approval:")) {
    await relayToRoom(task, reply, outcome.status).catch((error) =>
      log.error("room relay failed", { taskId: task.id, error })
    )
  }
}

// For the reply's "Used N skills": each skill once, with why it loaded
function skillsMetadata(used: Map<string, Resolution>) {
  const seen = new Map<
    string,
    { id: string; name: string; version: string; reason: string }
  >()
  for (const { active } of used.values())
    for (const { id, name, version, reason } of active)
      if (!seen.has(id)) seen.set(id, { id, name, version, reason })
  return [...seen.values()]
}

function summarize(output: unknown) {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}
