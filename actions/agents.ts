"use server"

import { eq, notExists } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"
import { z, ZodError } from "zod"

import { withUser } from "@/db"
import {
  agentInputSchema,
  agents,
  squadMembers,
  squads,
  threads,
  type AgentInput,
} from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { checkAgentAllowed } from "@/lib/entitlements"
import { checkSkillPrefs } from "@/lib/skill-library"

const id = z.string().min(1).max(32)

// Production hides a thrown action's message (React error #441), so what a
// person can fix comes back as { error }. Anything else still throws: a
// database error's text never reaches the browser.
class AgentError extends Error {}
type Failed = { error: string }

async function expected<T>(work: () => Promise<T>): Promise<T | Failed> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ZodError)
      return { error: error.issues[0]?.message ?? "Check the form and try again." }
    if (error instanceof AgentError) return { error: error.message }
    throw error
  }
}

function skillPrefs(input: unknown) {
  try {
    return checkSkillPrefs(input)
  } catch (error) {
    if (error instanceof ZodError) throw error
    // Its messages name the skill at fault ("… isn't a Kriya skill.")
    throw new AgentError(error instanceof Error ? error.message : "Check the skills.")
  }
}

async function normalize(values: AgentInput) {
  const data = agentInputSchema.parse(values)
  // Skills only with the library on, whatever the browser sends
  const skillsOn = (await getSetting("agents.skillLibrary")) === "on"
  return {
    name: data.name,
    role: data.role,
    instructions: data.instructions?.trim() || null,
    model: data.model?.trim() || null,
    ...(data.glyph && { glyph: data.glyph }),
    // Only when the Creator's Skills section sent them; ids checked here
    ...(skillsOn &&
      data.skills !== undefined && {
        skills: data.skills && skillPrefs(data.skills),
      }),
  }
}

// A new agent comes with an empty thread to talk to it in
export async function createAgent(values: AgentInput) {
  const user = await requireUser()
  return expected(async () => {
    const data = await normalize(values)
    const allowed = await checkAgentAllowed(user.id)
    if (!allowed.ok) throw new AgentError(allowed.message)
    const result = await withUser(user.id, async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({ ...data, id: nanoid(12), userId: user.id })
        .returning()
      const [thread] = await tx
        .insert(threads)
        .values({ id: nanoid(12), userId: user.id, agentId: agent.id })
        .returning({ id: threads.id })
      return { agent, threadId: thread.id }
    })
    revalidatePath("/", "layout")
    return result
  })
}

export async function updateAgent(agentId: string, values: AgentInput) {
  const user = await requireUser()
  return expected(async () => {
    const data = await normalize(values)
    const [agent] = await withUser(user.id, (tx) =>
      tx
        .update(agents)
        .set(data)
        .where(eq(agents.id, id.parse(agentId)))
        .returning()
    )
    if (!agent) throw new AgentError("Agent not found")
    revalidatePath("/", "layout")
    return agent
  })
}

// Deletes the agent with its threads, memory and tasks. A worker holding one
// of those tasks loses its lease at the next heartbeat and stops.
export async function deleteAgent(agentId: string) {
  const user = await requireUser()
  return expected(async () => {
    const target = id.parse(agentId)
    await withUser(user.id, async (tx) => {
      const removed = await tx
        .delete(agents)
        .where(eq(agents.id, target))
        .returning({ id: agents.id })
      if (removed.length === 0) throw new AgentError("Agent not found")
      // A squad left with nobody in it has nothing to show
      await tx
        .delete(squads)
        .where(
          notExists(
            tx.select().from(squadMembers).where(eq(squadMembers.squadId, squads.id))
          )
        )
    })
    revalidatePath("/", "layout")
  })
}
