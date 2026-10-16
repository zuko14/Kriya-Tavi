import { asc, desc, eq, gte, inArray, sql } from "drizzle-orm"

import { withUser, type Tx } from "@/db"
import {
  agents,
  charges,
  memories,
  squadMembers,
  squads,
  tasks,
  threads,
  toolExecutions,
  usageEvents,
} from "@/db/schema"
import { loadMessages } from "@/lib/agent/messages"
import { isOwner } from "@/lib/auth"
import { checkTaskAllowed, usageSummary } from "@/lib/entitlements"
import { isGatewayConfigured, TIER_LABELS } from "@/lib/models"
import { isWebConfigured } from "@/lib/web"

// Reads for server components. Every query runs as the signed-in person
// (withUser), so Row Level Security limits it to their own rows.

/* ───────────────────────────── sidebar ──────────────────────────── */

async function squadsWithAgents(tx: Tx) {
  const rows = await tx.query.squads.findMany({
    orderBy: asc(squads.createdAt),
    with: {
      members: { orderBy: asc(squadMembers.position), with: { agent: true } },
    },
  })
  return rows.map(({ members, ...squad }) => ({
    ...squad,
    agents: members.map((m) => m.agent),
  }))
}

export async function getSquads(userId: string) {
  return withUser(userId, squadsWithAgents)
}

export type SquadWithAgents = Awaited<ReturnType<typeof getSquads>>[number]

// Everything the shell needs: who exists, where their latest thread is,
// and which of them are working right now
export async function getNavigation(userId: string) {
  return withUser(userId, async (tx) => {
    const agentRows = await tx.select().from(agents).orderBy(asc(agents.createdAt))
    const squadRows = await squadsWithAgents(tx)
    const threadRows = await tx
      .select({
        id: threads.id,
        agentId: threads.agentId,
        squadId: threads.squadId,
        title: threads.title,
        preview: threads.preview,
        activeAt: threads.activeAt,
      })
      .from(threads)
      .orderBy(desc(threads.activeAt))
      .limit(200)
    const active = await tx
      .select({ threadId: tasks.threadId })
      .from(tasks)
      .where(inArray(tasks.status, ["queued", "running"]))

    const running = new Set(active.map((row) => row.threadId))
    const latest = new Map<string, string>()
    const busy = new Set<string>()
    for (const thread of threadRows) {
      const owner = thread.agentId ?? thread.squadId
      if (!owner) continue
      if (!latest.has(owner)) latest.set(owner, thread.id)
      if (running.has(thread.id)) busy.add(owner)
    }

    return {
      agents: agentRows.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        glyph: agent.glyph,
        model: agent.model,
        instructions: agent.instructions,
        latestThreadId: latest.get(agent.id) ?? null,
        busy: busy.has(agent.id),
      })),
      squads: squadRows.map((squad) => ({
        id: squad.id,
        name: squad.name,
        agentIds: squad.agents.map((agent) => agent.id),
        glyphs: squad.agents.map((agent) => agent.glyph),
        latestThreadId: latest.get(squad.id) ?? null,
        busy: busy.has(squad.id),
      })),
      threads: threadRows.slice(0, 60).map((thread) => ({
        ...thread,
        activeAt: thread.activeAt.toISOString(),
        busy: running.has(thread.id),
      })),
    }
  })
}

export type Navigation = Awaited<ReturnType<typeof getNavigation>>
export type NavAgent = Navigation["agents"][number]
export type NavSquad = Navigation["squads"][number]
export type NavThread = Navigation["threads"][number]

/* ───────────────────────────── threads ──────────────────────────── */

export async function getThread(userId: string, threadId: string) {
  return withUser(userId, async (tx) => {
    const thread = await tx.query.threads.findFirst({
      where: eq(threads.id, threadId),
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
    const members = thread.squad
      ? thread.squad.members.map((m) => m.agent)
      : thread.agent
        ? [thread.agent]
        : []
    if (members.length === 0) return null
    return { ...thread, members, messages: await loadMessages(tx, threadId) }
  })
}

export type ThreadView = NonNullable<Awaited<ReturnType<typeof getThread>>>

export async function getThreadsFor(
  userId: string,
  owner: { agentId?: string; squadId?: string }
) {
  const where = owner.agentId
    ? eq(threads.agentId, owner.agentId)
    : eq(threads.squadId, owner.squadId ?? "")
  return withUser(userId, (tx) =>
    tx
      .select({
        id: threads.id,
        title: threads.title,
        preview: threads.preview,
        activeAt: threads.activeAt,
      })
      .from(threads)
      .where(where)
      .orderBy(desc(threads.activeAt))
      .limit(50)
  )
}

export async function getLatestThreadId(
  userId: string,
  owner: { agentId?: string; squadId?: string }
) {
  return (await getThreadsFor(userId, owner))[0]?.id ?? null
}

export async function getMemories(userId: string, agentId: string) {
  return withUser(userId, (tx) =>
    tx
      .select()
      .from(memories)
      .where(eq(memories.agentId, agentId))
      .orderBy(desc(memories.createdAt))
  )
}

// The activity timeline for a thread: each task, what it ran on, the tools
// it used and what it cost
export async function getActivity(userId: string, threadId: string) {
  return withUser(userId, async (tx) => {
    const taskRows = await tx
      .select({
        id: tasks.id,
        status: tasks.status,
        tier: tasks.tier,
        model: tasks.model,
        attempts: tasks.attempts,
        errorCode: tasks.errorCode,
        error: tasks.error,
        createdAt: tasks.createdAt,
        startedAt: tasks.startedAt,
        finishedAt: tasks.finishedAt,
        chargeMicroInr: charges.chargeMicroInr,
        chargeStatus: charges.status,
      })
      .from(tasks)
      .leftJoin(charges, eq(charges.taskId, tasks.id))
      .where(eq(tasks.threadId, threadId))
      .orderBy(desc(tasks.createdAt))
      .limit(20)
    const ids = taskRows.map((task) => task.id)
    const tools = ids.length
      ? await tx
          .select({
            id: toolExecutions.id,
            taskId: toolExecutions.taskId,
            toolName: toolExecutions.toolName,
            status: toolExecutions.status,
            durationMs: toolExecutions.durationMs,
            outputSummary: toolExecutions.outputSummary,
            error: toolExecutions.error,
            startedAt: toolExecutions.startedAt,
          })
          .from(toolExecutions)
          .where(inArray(toolExecutions.taskId, ids))
          .orderBy(asc(toolExecutions.startedAt))
      : []
    const calls = ids.length
      ? await tx
          .select({
            taskId: usageEvents.taskId,
            n: sql<number>`count(*)::int`,
            input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
            output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
          })
          .from(usageEvents)
          .where(inArray(usageEvents.taskId, ids))
          .groupBy(usageEvents.taskId)
      : []
    return taskRows.map((task) => ({
      ...task,
      tools: tools.filter((tool) => tool.taskId === task.id),
      usage: calls.find((row) => row.taskId === task.id) ?? { n: 0, input: 0, output: 0 },
    }))
  })
}

export type Activity = Awaited<ReturnType<typeof getActivity>>

// Every task across agents and squads, newest first, for the Tasks screen
export async function getTasks(userId: string, limit = 60) {
  return withUser(userId, (tx) =>
    tx
      .select({
        id: tasks.id,
        status: tasks.status,
        tier: tasks.tier,
        errorCode: tasks.errorCode,
        createdAt: tasks.createdAt,
        startedAt: tasks.startedAt,
        finishedAt: tasks.finishedAt,
        threadId: tasks.threadId,
        threadTitle: threads.title,
        squadId: threads.squadId,
        squadName: squads.name,
        agentId: tasks.agentId,
        agentName: agents.name,
        agentGlyph: agents.glyph,
        charge: charges.chargeMicroInr,
        chargeStatus: charges.status,
      })
      .from(tasks)
      .leftJoin(agents, eq(tasks.agentId, agents.id))
      .leftJoin(threads, eq(tasks.threadId, threads.id))
      .leftJoin(squads, eq(threads.squadId, squads.id))
      .leftJoin(charges, eq(charges.taskId, tasks.id))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
  )
}

export type TaskRow = Awaited<ReturnType<typeof getTasks>>[number]

/* ───────────────────────────── status ───────────────────────────── */

export async function getSystemStatus(user: {
  id: string
  email: string | null
  profile: { displayName: string | null }
}) {
  const usage = await usageSummary(user.id)
  const running = await withUser(user.id, (tx) =>
    tx
      .select({ threadId: tasks.threadId })
      .from(tasks)
      .where(inArray(tasks.status, ["queued", "running"]))
  )
  const limit = checkTaskAllowed(usage)
  return {
    user: { name: user.profile.displayName, email: user.email },
    owner: await isOwner(user.id),
    ready: isGatewayConfigured(),
    web: isWebConfigured(),
    running: running.map((row) => row.threadId),
    plan: {
      id: usage.plan.id,
      name: usage.plan.name,
      allowedTiers: usage.plan.allowedTiers,
      maxAgents: usage.plan.maxAgents,
      maxTasksPerDay: usage.plan.maxTasksPerDay,
    },
    tiers: TIER_LABELS,
    usage: {
      usedMicroInr: usage.usedMicroInr,
      allowanceMicroInr: usage.allowanceMicroInr,
      usedPct: usage.usedPct,
      tasksToday: usage.tasksToday,
      // Warn once the period's allowance or today's tasks are mostly used
      warn:
        (usage.usedPct ?? 0) >= usage.plan.warnAtPct ||
        usage.tasksToday >=
          Math.ceil((usage.plan.maxTasksPerDay * usage.plan.warnAtPct) / 100),
      blocked: limit.ok ? null : limit.message,
    },
  }
}

export type SystemStatus = Awaited<ReturnType<typeof getSystemStatus>>

/* ────────────────────────────── usage ───────────────────────────── */

export async function getUsage(userId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return withUser(userId, async (tx) => {
    const window = gte(tasks.createdAt, since)
    const [totals] = await tx
      .select({
        tasks: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')::int`,
        charge: sql<number>`coalesce(sum(${charges.chargeMicroInr}), 0)::bigint`.mapWith(
          Number
        ),
        estimated: sql<number>`count(*) filter (where ${charges.status} = 'estimated')::int`,
      })
      .from(tasks)
      .leftJoin(charges, eq(charges.taskId, tasks.id))
      .where(window)

    const [tokens] = await tx
      .select({
        input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`.mapWith(
          Number
        ),
        output:
          sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::bigint`.mapWith(
            Number
          ),
        calls: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since))

    const byAgent = await tx
      .select({
        agentId: tasks.agentId,
        name: agents.name,
        glyph: agents.glyph,
        tasks: sql<number>`count(*)::int`,
        charge: sql<number>`coalesce(sum(${charges.chargeMicroInr}), 0)::bigint`.mapWith(
          Number
        ),
      })
      .from(tasks)
      .leftJoin(agents, eq(tasks.agentId, agents.id))
      .leftJoin(charges, eq(charges.taskId, tasks.id))
      .where(window)
      .groupBy(tasks.agentId, agents.name, agents.glyph)
      .orderBy(desc(sql`count(*)`))

    // Day buckets in India time, oldest first
    const daily = await tx
      .select({
        day: sql<string>`to_char(${tasks.createdAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
        tasks: sql<number>`count(*)::int`,
        charge: sql<number>`coalesce(sum(${charges.chargeMicroInr}), 0)::bigint`.mapWith(
          Number
        ),
      })
      .from(tasks)
      .leftJoin(charges, eq(charges.taskId, tasks.id))
      .where(window)
      .groupBy(sql`1`)
      .orderBy(sql`1`)

    const recent = await tx
      .select({
        id: tasks.id,
        status: tasks.status,
        tier: tasks.tier,
        errorCode: tasks.errorCode,
        createdAt: tasks.createdAt,
        startedAt: tasks.startedAt,
        finishedAt: tasks.finishedAt,
        threadId: tasks.threadId,
        squadId: threads.squadId,
        agentId: tasks.agentId,
        agentName: agents.name,
        agentGlyph: agents.glyph,
        charge: charges.chargeMicroInr,
        chargeStatus: charges.status,
      })
      .from(tasks)
      .leftJoin(agents, eq(tasks.agentId, agents.id))
      .leftJoin(threads, eq(tasks.threadId, threads.id))
      .leftJoin(charges, eq(charges.taskId, tasks.id))
      .orderBy(desc(tasks.createdAt))
      .limit(25)

    return { days, totals, tokens, byAgent, daily, recent }
  })
}

export type UsageData = Awaited<ReturnType<typeof getUsage>>

export async function countRows(userId: string) {
  return withUser(userId, async (tx) => {
    const one = async (
      table: typeof agents | typeof squads | typeof threads | typeof memories
    ) => (await tx.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n ?? 0
    return {
      agents: await one(agents),
      squads: await one(squads),
      threads: await one(threads),
      memories: await one(memories),
    }
  })
}
