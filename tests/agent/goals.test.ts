import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, withUser, type DB } from "@/db"
import * as schema from "@/db/schema"
import { createGoal, updateGoal } from "@/lib/goals"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// AT-GOL-01: a goal is "achieved" only when every checklist item is done
// and linked to an episode, a record derived from verified tool runs. The
// agent's word is never enough, and someone else's record doesn't count.

let pg: TestDb
let alice: string
let bob: string

async function episode(user: string, seq: number) {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.episodes (user_id, thread_id, done, seq, hash)
     values ($1, 'x', '[{"tool":"schedule_create"}]', $2, $3) returning id`,
    [user, seq, `h${seq}`]
  )
  return rows[0].id
}

async function goal(plan: string[]) {
  return withUser(alice, (tx) =>
    createGoal(tx, { userId: alice, agentId: "a1", title: "Crack GATE", plan })
  )
}

const items = async (goalId: string) =>
  (
    await pg.query<{ plan: schema.PlanItem[]; status: string }>(
      "select plan, status from kriya.goals where id = $1",
      [goalId]
    )
  ).rows[0]

const achieve = (
  goalId: string,
  planUpdates: Parameters<typeof updateGoal>[2]["planUpdates"]
) => withUser(alice, (tx) => updateGoal(tx, goalId, { planUpdates, status: "achieved" }))

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  await asUser(pg, alice, (tx) =>
    tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Disha', 'Study', 'g')",
      [alice]
    )
  )
})

describe("goal_update(achieved) needs evidence (AT-GOL-01)", () => {
  it("creates the goal in its own thread with a todo checklist", async () => {
    const { goalId, threadId } = await goal(["Syllabus", "Mock test"])
    const row = await items(goalId)
    expect(row.status).toBe("active")
    expect(row.plan.map((i) => [i.text, i.status])).toEqual([
      ["Syllabus", "todo"],
      ["Mock test", "todo"],
    ])
    const { rows } = await pg.query("select 1 from kriya.threads where id = $1", [
      threadId,
    ])
    expect(rows).toHaveLength(1)
  })

  it("refuses while any item isn't done, or is done without a record", async () => {
    const { goalId } = await goal(["Syllabus", "Mock test"])
    const [first, second] = (await items(goalId)).plan
    const proof = await episode(alice, 1)
    await expect(achieve(goalId, [])).rejects.toThrow(/every checklist item is done/)
    await expect(
      achieve(goalId, [
        { id: first.id, status: "done", evidenceEpisodeId: proof },
        { id: second.id, status: "done" },
      ])
    ).rejects.toThrow(/every checklist item is done/)
    expect((await items(goalId)).status).toBe("active")
  })

  it("refuses a record that doesn't exist, or belongs to someone else", async () => {
    const { goalId } = await goal(["Syllabus"])
    const [only] = (await items(goalId)).plan
    await expect(
      achieve(goalId, [
        {
          id: only.id,
          status: "done",
          evidenceEpisodeId: "00000000-0000-0000-0000-000000000000",
        },
      ])
    ).rejects.toThrow(/No record of what was done/)
    const theirs = await episode(bob, 1)
    await expect(
      achieve(goalId, [{ id: only.id, status: "done", evidenceEpisodeId: theirs }])
    ).rejects.toThrow(/No record of what was done/)
  })

  it("refuses an empty checklist: nothing proves it", async () => {
    const { goalId } = await goal([])
    await expect(achieve(goalId, [])).rejects.toThrow(/every checklist item is done/)
  })

  it("accepts when every item is done and linked to the person's own record", async () => {
    const { goalId } = await goal(["Syllabus", "Mock test"])
    const [first, second] = (await items(goalId)).plan
    const proof = await episode(alice, 1)
    await achieve(goalId, [
      { id: first.id, status: "done", evidenceEpisodeId: proof },
      { id: second.id, status: "done", evidenceEpisodeId: proof },
    ])
    const row = await items(goalId)
    expect(row.status).toBe("achieved")
    expect(row.plan.every((i) => i.evidence === proof)).toBe(true)
  })
})
