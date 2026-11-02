import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { TestDb } from "../db/harness"
import { roomsDb, roomsEnv, tokenOf } from "./setup"

// RT-GOAL-01/02 (R7, RD-13): an item closes only with an attached card
// whose chosen action is verified, or by a member's confirmation labelled
// "no proof"; the goal's state is computed from its items, by code, and
// said in the room; nobody, no tool and no model sets it.

vi.mock("server-only", () => ({}))
const session = vi.hoisted(() => ({ user: "", ip: 0 }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: session.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `10.8.0.${++session.ip % 250}` }),
}))

import {
  addGoalItem,
  closeGoalItemWithProof,
  confirmGoalItem,
  createGoal,
  createInvite,
  createRoom,
  dropRoomGoal,
  joinRoom,
  removeGoalItem,
  reopenGoalItem,
} from "@/actions/rooms"
import { PERSON_ONLY_WRITES, TOOL_WRITES } from "@/lib/agent/policy"
import { goalState } from "@/lib/rooms/goals"
import { goalsFor } from "@/queries/rooms"

let pg: TestDb
let newUser: () => Promise<string>
const as = (user: string) => (session.user = user)
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

async function room() {
  const asha = await newUser()
  const ravi = await newUser()
  await q("update kriya.profiles set display_name = 'Ravi' where id = $1", [ravi])
  as(asha)
  const made = await createRoom({ title: "Launch" })
  if (!("ok" in made)) throw new Error(made.error)
  const invite = await createInvite({ roomId: made.roomId })
  if (!("ok" in invite)) throw new Error(invite.error)
  as(ravi)
  await joinRoom(tokenOf(invite.url))
  return { asha, ravi, roomId: made.roomId }
}

// An agent's reply with a card: action 0 verified, action 1 not
const card = async (roomId: string, owner: string) =>
  (
    await q<{ id: string }>(
      `insert into kriya.room_messages (room_id, author_kind, user_id, agent_id, body, parts)
       values ($1, 'agent', $2, 'lekha', 'Done', $3) returning id`,
      [
        roomId,
        owner,
        JSON.stringify({
          proof: {
            kind: "proof",
            done: [
              {
                title: "Opened a PR",
                status: "verified",
                method: "api_readback",
                evidence: [],
              },
              {
                title: "Updated a sheet",
                status: "unverified",
                method: "none",
                evidence: [],
              },
            ],
            unconfirmed: 0,
            checks: { supported: 0, unsupported: 0 },
            verifiedBy: [],
          },
        }),
      ]
    )
  )[0].id

const lines = async (roomId: string) =>
  (
    await q<{ body: string }>(
      "select body from kriya.room_messages where room_id = $1 and author_kind = 'system' order by seq",
      [roomId]
    )
  ).map((r) => r.body)

async function goal(r: { roomId: string }, items = ["PR merged", "Price sheet updated"]) {
  const made = await createGoal({ roomId: r.roomId, title: "Launch ready", items })
  if (!("ok" in made)) throw new Error(made.error)
  const [view] = await goalsFor(session.user, r.roomId)
  return { goalId: made.goalId, items: view.items }
}

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await roomsDb())
})
beforeEach(() => roomsEnv())

describe("RT-GOAL-02: the state comes from the items (pure)", () => {
  it("done only when every item is closed; dropped stays dropped", () => {
    expect(goalState("open", [])).toBe("open")
    expect(goalState("open", [{ closedAt: new Date() }, { closedAt: null }])).toBe("open")
    expect(goalState("open", [{ closedAt: new Date() }])).toBe("done")
    expect(goalState("done", [{ closedAt: null }])).toBe("open")
    expect(goalState("dropped", [{ closedAt: new Date() }])).toBe("dropped")
  })

  it("no tool writes goals; they're people's (PERSON_ONLY_WRITES)", () => {
    expect(PERSON_ONLY_WRITES).toEqual(
      expect.arrayContaining(["room_goals", "room_goal_items"])
    )
    for (const [tool, writes] of Object.entries(TOOL_WRITES))
      expect(
        writes.filter((w) => w.startsWith("room_goal")),
        tool
      ).toEqual([])
  })
})

describe("RT-GOAL-01: closing items", () => {
  it("with a verified action on a card, or a confirmation labelled no proof; the goal follows", async () => {
    const r = await room()
    as(r.ravi)
    const g = await goal(r)
    const proof = await card(r.roomId, r.asha)
    expect(
      await closeGoalItemWithProof({
        roomId: r.roomId,
        itemId: g.items[0].id,
        messageId: proof,
        index: 1,
      })
    ).toEqual({
      error: "Only a verified action on a proof card in this room can close it.",
    })
    expect(
      await closeGoalItemWithProof({
        roomId: r.roomId,
        itemId: g.items[0].id,
        messageId: proof,
        index: 0,
      })
    ).toEqual({ ok: true })
    expect(await confirmGoalItem({ roomId: r.roomId, itemId: g.items[1].id })).toEqual({
      ok: true,
    })
    const [view] = await goalsFor(r.ravi, r.roomId)
    expect(view.status).toBe("done")
    expect(view.items.map((i) => [i.text, i.closed])).toEqual([
      ["PR merged", { proof: { title: "Opened a PR", agent: expect.any(String) } }],
      ["Price sheet updated", { confirmedBy: "Ravi" }],
    ])
    expect((await lines(r.roomId)).slice(-3)).toEqual([
      "Ravi closed “PR merged” with a verified action on a proof card.",
      "Ravi confirmed “Price sheet updated” without proof.",
      "Goal “Launch ready” is done: 1 of 2 items closed with proof, 1 confirmed without.",
    ])

    // Reopening one opens the goal again; adding one keeps it open
    expect(await reopenGoalItem({ roomId: r.roomId, itemId: g.items[1].id })).toEqual({
      ok: true,
    })
    expect((await goalsFor(r.ravi, r.roomId))[0].status).toBe("open")
    expect((await lines(r.roomId)).at(-1)).toBe("Goal “Launch ready” is open again.")
    await addGoalItem({ roomId: r.roomId, goalId: g.goalId, text: "Landing page live" })
    expect((await goalsFor(r.ravi, r.roomId))[0].items).toHaveLength(3)
    // Removing the open ones leaves only closed items: done
    const [now] = await goalsFor(r.ravi, r.roomId)
    for (const item of now.items.filter((i) => !i.closed))
      await removeGoalItem({ roomId: r.roomId, itemId: item.id })
    expect((await goalsFor(r.ravi, r.roomId))[0].status).toBe("done")
  })

  it("a card from another room never closes an item", async () => {
    const r = await room()
    as(r.asha)
    const other = await createRoom({ title: "Other" })
    if (!("ok" in other)) throw new Error(other.error)
    const elsewhere = await card(other.roomId, r.asha)
    const g = await goal(r)
    expect(
      await closeGoalItemWithProof({
        roomId: r.roomId,
        itemId: g.items[0].id,
        messageId: elsewhere,
        index: 0,
      })
    ).toEqual({
      error: "Only a verified action on a proof card in this room can close it.",
    })
  })

  it("only members; dropping is for the owner, admins and whoever set it", async () => {
    const r = await room()
    as(r.ravi)
    const g = await goal(r)
    const outsider = await newUser()
    as(outsider)
    expect(await confirmGoalItem({ roomId: r.roomId, itemId: g.items[0].id })).toEqual({
      error: "Item not found.",
    })
    expect(await goalsFor(outsider, r.roomId)).toEqual([])
    expect(await dropRoomGoal({ roomId: r.roomId, goalId: g.goalId })).toEqual({
      error: "Goal not found.",
    })

    // Asha's goal: Ravi, a plain member who didn't set it, can't drop it
    as(r.asha)
    const mine = await createGoal({ roomId: r.roomId, title: "Hers", items: ["x"] })
    if (!("ok" in mine)) throw new Error(mine.error)
    as(r.ravi)
    expect(await dropRoomGoal({ roomId: r.roomId, goalId: mine.goalId })).toEqual({
      error: "Goal not found.",
    })
    // His own he can; and the owner can drop anyone's
    expect(await dropRoomGoal({ roomId: r.roomId, goalId: g.goalId })).toEqual({
      ok: true,
    })
    as(r.asha)
    expect(await dropRoomGoal({ roomId: r.roomId, goalId: mine.goalId })).toEqual({
      ok: true,
    })
    const statuses = (await goalsFor(r.asha, r.roomId)).map((x) => x.status)
    expect(statuses).toEqual(["dropped", "dropped"])
  })

  it("nothing with rooms.enabled off", async () => {
    const r = await room()
    roomsEnv({ KRIYA_ROOMS_ENABLED: "off" })
    as(r.asha)
    expect(await createGoal({ roomId: r.roomId, title: "x", items: ["y"] })).toEqual({
      error: "Room not found.",
    })
    expect(await goalsFor(r.asha, r.roomId)).toEqual([])
  })
})
