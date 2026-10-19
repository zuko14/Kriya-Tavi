import { count } from "drizzle-orm"
import { nanoid } from "nanoid"

import type { Q } from "@/db"
import { agents, squadMembers, squads, threads } from "@/db/schema"
import { addPersonNote, refuseSensitive } from "@/lib/memory/person"
import { packFor } from "@/lib/templates"

// "Meet your team" (A2, AD-14): a role pack's chosen agents, their squad
// and its thread, and the person's answers as "About you" notes. Called
// inside withUser, so it is one transaction under Row Level Security: a
// refusal anywhere writes nothing. Members and slots come from the pack,
// never from the browser's word.

// Refusals meant for the person; anything else is an unexpected failure
export class TeamError extends Error {}

export async function createTeam(
  tx: Q,
  userId: string,
  input: {
    useCase: string | null | undefined
    members: string[]
    about: { slot: string; content: string }[]
    maxAgents: number
  }
) {
  const pack = packFor(input.useCase)
  const chosen = [...new Set(input.members)].map((name) => {
    const member = pack.members.find((m) => m.name === name)
    if (!member) throw new TeamError(`${name} isn't part of this team.`)
    return member
  })
  if (chosen.length === 0) throw new TeamError("Choose at least one agent for your team.")
  const answers = input.about
    .map(({ slot, content }) => ({ slot, content: content.trim() }))
    .filter(({ content }) => content)
  for (const { slot, content } of answers) {
    if (!pack.slots.some((s) => s.slot === slot))
      throw new TeamError("Unknown profile slot.")
    try {
      refuseSensitive(content, slot, "user")
    } catch (error) {
      throw new TeamError((error as Error).message)
    }
  }

  // Someone who already has agents keeps them as they are
  const [existing] = await tx.select({ n: count() }).from(agents)
  if ((existing?.n ?? 0) > 0) return "/home"
  if (chosen.length > input.maxAgents) {
    throw new TeamError(
      `Your plan includes ${input.maxAgents} agents. Choose ${input.maxAgents} or fewer; you can add others later.`
    )
  }

  const created = await tx
    .insert(agents)
    .values(
      chosen.map((member) => ({
        id: nanoid(12),
        userId,
        name: member.name,
        role: member.role,
        instructions: member.instructions,
      }))
    )
    .returning({ id: agents.id, name: agents.name })
  const idOf = (name: string) => created.find((agent) => agent.name === name)!.id

  for (const { slot, content } of answers) {
    await addPersonNote(tx, userId, { content, kind: "profile", slot })
  }

  if (chosen.length === 1) {
    const agentId = created[0].id
    const [thread] = await tx
      .insert(threads)
      .values({ id: nanoid(12), userId, agentId })
      .returning({ id: threads.id })
    return `/a/${agentId}/${thread.id}`
  }
  const [squad] = await tx
    .insert(squads)
    .values({ id: nanoid(12), userId, name: pack.teamName })
    .returning({ id: squads.id })
  await tx.insert(squadMembers).values(
    chosen.map((member, position) => ({
      squadId: squad.id,
      agentId: idOf(member.name),
      userId,
      position,
    }))
  )
  const [thread] = await tx
    .insert(threads)
    .values({ id: nanoid(12), userId, squadId: squad.id })
    .returning({ id: threads.id })
  return `/s/${squad.id}/${thread.id}`
}
