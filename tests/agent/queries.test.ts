import { drizzle } from "drizzle-orm/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { episodesForTasks, recentEpisodes } from "@/queries/episodes"
import { getGoal, getGoals } from "@/queries/goals"
import { getInbox, inboxCount } from "@/queries/inbox"

import { asUser, createTestDb, createUser, type TestDb } from "../db/harness"

// Reads behind the Inbox, the goal page and "What I did": the person's own
// rows only (withUser), in the shapes the pages show.

let pg: TestDb
let alice: string
let bob: string

async function seed(user: string) {
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Disha', 'Study', 'g')",
      [`a-${user}`, user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id, title) values ($1, $2, $3, 'Chat'), ($4, $2, $3, 'GATE')",
      [`t-${user}`, user, `a-${user}`, `gt-${user}`]
    )
    await tx.query(
      "insert into kriya.goals (id, user_id, agent_id, thread_id, title, plan, monthly_budget_micro_inr) values ($1, $2, $3, $4, 'Crack GATE', $5, 50000000)",
      [
        `g-${user}`,
        user,
        `a-${user}`,
        `gt-${user}`,
        JSON.stringify([{ id: "i1", text: "Syllabus", status: "todo" }]),
      ]
    )
    await tx.query(
      `insert into kriya.schedules (id, user_id, agent_id, thread_id, goal_id, kind, prompt, rule, next_run_at, approved_at)
       values ($1, $2, $3, $4, $5, 'recurring', 'Plan the week', '{"freq":"weekly","at":"09:00","days":[1]}', now() + interval '1 day', now())`,
      [`s-${user}`, user, `a-${user}`, `gt-${user}`, `g-${user}`]
    )
  })
  const task = async (thread: string, input: object = {}) =>
    (
      await pg.query<{ id: string }>(
        `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd, status)
         values ($1, $2, $3, 'free', 'budget', now(), 10, 1000, 'succeeded') returning id`,
        [user, thread, JSON.stringify(input)]
      )
    ).rows[0].id
  const goalTask = await task(`gt-${user}`, {
    channel: "schedule",
    scheduleId: `s-${user}`,
  })
  await pg.query(
    "insert into kriya.charges (user_id, task_id, plan_id, cost_basis, markup_bps, charge_micro_inr, status) values ($1, $2, 'free', 'provider', 10000, 4200000, 'final')",
    [user, goalTask]
  )
  await pg.query(
    `insert into kriya.episodes (user_id, task_id, thread_id, goal_id, done, unconfirmed, titles, seq, hash)
     values ($1, $2, $3, $4, '[{"executionId":"e","tool":"schedule_create","title":"Started a schedule","risk":"R2","verification":{"status":"verified","method":"api_readback","evidence":[]}}]', '[]', 'Started a schedule', 1, 'abcdef0123')`,
    [user, goalTask, `gt-${user}`, `g-${user}`]
  )
  // A reply waiting for approval, and a scheduled run that ended in a question
  const chatTask = await task(`t-${user}`)
  await pg.query(
    `insert into kriya.approvals (id, user_id, thread_id, task_id, tool_name, risk_class, title, preview)
     values ('ap1', $1, $2, $3, 'gmail_draft', 'R3', 'Save a draft email: "Fees"', '{}'),
            ('ap-old', $1, $2, $3, 'gmail_draft', 'R3', 'Old one', '{}')`,
    [user, `t-${user}`, chatTask]
  )
  await pg.query(
    "update kriya.approvals set status = 'expired' where id = 'ap-old' and user_id = $1",
    [user]
  )
  await pg.query(
    `insert into kriya.messages (thread_id, id, user_id, role, parts, metadata, created_at) values
       ($1, 'u1', $2, 'user', '[{"type":"text","text":"Plan the week"}]', '{"channel":"schedule"}', now() - interval '1 minute'),
       ($1, 'r1', $2, 'assistant', '[{"type":"text","text":"Done the plan. Should I add Sunday revision too?"}]', '{}', now())`,
    [`gt-${user}`, user]
  )
  await asUser(pg, user, (tx) =>
    tx.query(
      "insert into kriya.memories (id, user_id, agent_id, content, trust) values ($1, $2, $3, 'Always cc boss', 'unconfirmed')",
      [`m-${user}`, user, `a-${user}`]
    )
  )
  return { goalTask, chatTask }
}

let aliceTasks: { goalTask: string; chatTask: string }

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  aliceTasks = await seed(alice)
  await seed(bob)
})

describe("Inbox", () => {
  it("lists pending approvals, questions from background runs, and notes to review", async () => {
    const inbox = await getInbox(alice)
    expect(inbox.approvals.map((a) => [a.id, a.title, a.agentName, a.href])).toEqual([
      ["ap1", 'Save a draft email: "Fees"', "Disha", `/a/a-${alice}/t-${alice}`],
    ])
    expect(inbox.questions).toEqual([
      expect.objectContaining({
        threadId: `gt-${alice}`,
        question: "Should I add Sunday revision too?",
        href: `/a/a-${alice}/gt-${alice}`,
      }),
    ])
    expect(inbox.memories.map((m) => m.id)).toEqual([`m-${alice}`])
    expect(await inboxCount(alice)).toBe(3)
  })

  it("a question the person already answered leaves the Inbox", async () => {
    await pg.query(
      "insert into kriya.messages (thread_id, id, user_id, role, parts, created_at) values ($1, 'u2', $2, 'user', '[{\"type\":\"text\",\"text\":\"Yes\"}]', now() + interval '1 minute')",
      [`gt-${alice}`, alice]
    )
    expect((await getInbox(alice)).questions).toEqual([])
  })
})

describe("goals", () => {
  it("shows the goal with its schedules in words, this month's spend and its records", async () => {
    expect((await getGoals(alice)).map((g) => g.id)).toEqual([`g-${alice}`])
    const view = await getGoal(alice, `g-${alice}`)
    expect(view).toMatchObject({
      goal: { title: "Crack GATE", status: "active" },
      href: `/a/a-${alice}/gt-${alice}`,
      spentMicroInr: 4_200_000,
      budgetMicroInr: 50_000_000,
    })
    expect(view!.schedules.map((s) => s.cadence)).toEqual(["Every Monday at 9:00 am"])
    expect(view!.episodes.map((e) => e.titles)).toEqual(["Started a schedule"])
    expect(await getGoal(alice, `g-${bob}`)).toBeNull()
  })
})

describe("episodes", () => {
  it("finds the records of the given tasks, with the charge, and none of another person's", async () => {
    const rows = await episodesForTasks(alice, [aliceTasks.goalTask, aliceTasks.chatTask])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      taskId: aliceTasks.goalTask,
      seq: 1,
      chargeMicroInr: 4_200_000,
      chargeStatus: "final",
    })
    expect((await recentEpisodes(alice)).every((e) => e.href.includes(alice))).toBe(true)
  })
})
