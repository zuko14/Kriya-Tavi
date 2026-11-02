import { inArray } from "drizzle-orm"

import { privileged } from "@/db"
import { agents, profiles } from "@/db/schema"

// Names in a room (track R, R4): people's display names and agents' names,
// read through privileged because profiles and agents are owner-only.
// Callers have already established the reader's right to the room (RLS or
// the worker's own task); only the ids of that room's rows are looked up,
// and nothing but the name is read (RF-08). No server-only marker: the
// worker loads this through runTask.

type Author = { authorKind?: string; userId: string | null; agentId: string | null }

export async function roomNames(rows: Author[]) {
  const people = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))]
  const bots = [...new Set(rows.flatMap((r) => (r.agentId ? [r.agentId] : [])))]
  const [personRows, agentRows] = await Promise.all([
    people.length
      ? privileged
          .select({ id: profiles.id, name: profiles.displayName })
          .from(profiles)
          .where(inArray(profiles.id, people))
      : [],
    bots.length
      ? privileged
          .select({ id: agents.id, userId: agents.userId, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, bots))
      : [],
  ])
  const person = new Map(personRows.map((p) => [p.id, p.name || "Member"]))
  const agent = new Map(agentRows.map((a) => [`${a.userId}:${a.id}`, a.name]))
  const personName = (id: string | null) => (id && person.get(id)) || "Member"
  const agentName = (owner: string | null, id: string) =>
    agent.get(`${owner}:${id}`) ?? "Agent"
  return {
    person: personName,
    agent: agentName,
    // "Ravi", or "Lekha (agent of Asha)"
    label: (row: Author) =>
      row.agentId
        ? `${agentName(row.userId, row.agentId)} (agent of ${personName(row.userId)})`
        : personName(row.userId),
  }
}
