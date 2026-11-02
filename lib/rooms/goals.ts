import { and, eq, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { roomGoals } from "@/db/schema"
import { postSystemLine } from "@/lib/rooms/agents"

// Room goals (track R, R7; RD-13): a goal is done when every item is
// closed (with a verified action on a proof card, or a member's own
// confirmation, "no proof"), and open again when one reopens. Code computes
// that from the items and writes it here only: no client role can set a
// goal's status (the column isn't granted), no tool writes goals
// (PERSON_ONLY_WRITES), no model decides. Called after a member's change
// passed the membership policies; scoped to that goal and room.

export type GoalState = "open" | "done" | "dropped"

// RT-GOAL-02: the state from the items alone (pure)
export function goalState(
  current: GoalState,
  items: { closedAt: Date | string | null }[]
): GoalState {
  if (current === "dropped") return "dropped"
  return items.length > 0 && items.every((i) => i.closedAt) ? "done" : "open"
}

// Writes the computed state; a goal that became done says so in the room
export async function recomputeGoal(roomId: string, goalId: string) {
  const [goal] = await privileged
    .select({ status: roomGoals.status, title: roomGoals.title })
    .from(roomGoals)
    .where(and(eq(roomGoals.id, goalId), eq(roomGoals.roomId, roomId)))
  if (!goal) return null
  const items = rowsOf<{ closed_at: string | null; proof: boolean }>(
    await privileged.execute(
      sql`select closed_at, proof_message_id is not null as proof
          from kriya.room_goal_items where goal_id = ${goalId} and room_id = ${roomId}`
    )
  )
  const next = goalState(
    goal.status,
    items.map((i) => ({ closedAt: i.closed_at }))
  )
  if (next === goal.status) return next
  await privileged
    .update(roomGoals)
    .set({ status: next })
    .where(and(eq(roomGoals.id, goalId), eq(roomGoals.roomId, roomId)))
  if (next === "done") {
    const proven = items.filter((i) => i.proof).length
    await postSystemLine(
      roomId,
      `Goal “${goal.title}” is done: ${proven} of ${items.length} ${items.length === 1 ? "item" : "items"} closed with proof${proven < items.length ? `, ${items.length - proven} confirmed without` : ""}.`,
      { kind: "goal", goalId }
    )
  } else {
    await postSystemLine(roomId, `Goal “${goal.title}” is open again.`, {
      kind: "goal",
      goalId,
    })
  }
  return next
}

// A person dropped the goal (owner, admin or its creator; checked by the action)
export async function dropGoal(roomId: string, goalId: string, by: string) {
  const [goal] = await privileged
    .update(roomGoals)
    .set({ status: "dropped" })
    .where(
      and(
        eq(roomGoals.id, goalId),
        eq(roomGoals.roomId, roomId),
        sql`${roomGoals.status} <> 'dropped'`
      )
    )
    .returning({ title: roomGoals.title })
  if (!goal) return false
  await postSystemLine(roomId, `${by} dropped the goal “${goal.title}”.`, {
    kind: "goal",
    goalId,
  })
  return true
}
