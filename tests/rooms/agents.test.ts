import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { TestDb } from "../db/harness"
import { roomsDb, roomsEnv, tokenOf } from "./setup"

// R4: a person's own agents in a room. Only the owner adds, removes or sets
// the policy of an agent; the room's agent limit holds; leaving or being
// removed takes a person's agents out; the page shows spend to the owner
// only and "limit reached" to others (RD-17).

vi.mock("server-only", () => ({}))
const session = vi.hoisted(() => ({ user: "", ip: 0 }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: session.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `10.4.0.${++session.ip % 250}` }),
}))

import {
  addRoomAgent,
  createInvite,
  createRoom,
  joinRoom,
  leaveRoom,
  removeMember,
  removeRoomAgent,
  setRoomAgentPolicy,
} from "@/actions/rooms"
import { myAgentsToAdd, roomAgentsFor } from "@/queries/rooms"

let pg: TestDb
let newUser: () => Promise<string>
const as = (user: string) => (session.user = user)
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows

let n = 0
async function agentOf(user: string, name: string) {
  const id = `${name.toLowerCase()}-${++n}`
  await q(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, $3, 'r', 'g')",
    [id, user, name]
  )
  return id
}

async function room() {
  const asha = await newUser()
  const ravi = await newUser()
  as(asha)
  const made = await createRoom({ title: "Launch" })
  if (!("ok" in made)) throw new Error(made.error)
  const invite = await createInvite({ roomId: made.roomId })
  if (!("ok" in invite)) throw new Error(invite.error)
  as(ravi)
  await joinRoom(tokenOf(invite.url))
  return { asha, ravi, roomId: made.roomId }
}

const active = (roomId: string) =>
  q<{ agent_id: string }>(
    "select agent_id from kriya.room_agents where room_id = $1 and removed_at is null order by agent_id",
    [roomId]
  )

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await roomsDb())
})
beforeEach(() =>
  roomsEnv({
    KRIYA_ROOMS_AGENTS: "on",
    KRIYA_AGENTS_INBOX: "on",
    KRIYA_ROOMS_MAX_AGENTS: undefined,
  })
)

describe("adding an agent", () => {
  it("makes a bridge thread in the owner's account; adding again reuses it", async () => {
    const r = await room()
    const lekha = await agentOf(r.asha, "Lekha")
    as(r.asha)
    expect(await addRoomAgent({ roomId: r.roomId, agentId: lekha })).toEqual({ ok: true })
    const [row] = await q<{ bridge_thread_id: string; owner_id: string; invoke: string }>(
      "select bridge_thread_id, owner_id, invoke from kriya.room_agents where room_id = $1",
      [r.roomId]
    )
    expect(row).toMatchObject({ owner_id: r.asha, invoke: "owner_only" })
    expect(
      await q("select user_id, agent_id, title from kriya.threads where id = $1", [
        row.bridge_thread_id,
      ])
    ).toEqual([{ user_id: r.asha, agent_id: lekha, title: "Room · Launch" }])
    expect(await removeRoomAgent({ roomId: r.roomId, agentId: lekha })).toEqual({
      ok: true,
    })
    expect(await active(r.roomId)).toEqual([])
    expect(await addRoomAgent({ roomId: r.roomId, agentId: lekha })).toEqual({ ok: true })
    expect(
      await q("select bridge_thread_id from kriya.room_agents where room_id = $1", [
        r.roomId,
      ])
    ).toEqual([{ bridge_thread_id: row.bridge_thread_id }])
  })

  it("only one's own agent, only as a member, within rooms.maxAgents", async () => {
    roomsEnv({
      KRIYA_ROOMS_AGENTS: "on",
      KRIYA_AGENTS_INBOX: "on",
      KRIYA_ROOMS_MAX_AGENTS: "1",
    })
    const r = await room()
    const lekha = await agentOf(r.asha, "Lekha")
    const mira = await agentOf(r.ravi, "Mira")
    const outsider = await newUser()
    const other = await agentOf(outsider, "Other")
    as(r.ravi)
    expect(await addRoomAgent({ roomId: r.roomId, agentId: lekha })).toEqual({
      error: "Agent not found.",
    })
    as(outsider)
    expect(await addRoomAgent({ roomId: r.roomId, agentId: other })).toEqual({
      error: "Room not found.",
    })
    as(r.asha)
    expect(await addRoomAgent({ roomId: r.roomId, agentId: lekha })).toEqual({ ok: true })
    as(r.ravi)
    expect(await addRoomAgent({ roomId: r.roomId, agentId: mira })).toEqual({
      error: "A room can have at most 1 agents.",
    })
  })

  it("needs rooms.agents and agents.inbox on", async () => {
    const r = await room()
    const lekha = await agentOf(r.asha, "Lekha")
    roomsEnv({ KRIYA_ROOMS_AGENTS: "on", KRIYA_AGENTS_INBOX: undefined })
    as(r.asha)
    expect(await addRoomAgent({ roomId: r.roomId, agentId: lekha })).toEqual({
      error: expect.any(String),
    })
    expect(await active(r.roomId)).toEqual([])
    expect(await roomAgentsFor(r.asha, r.roomId)).toEqual([])
    expect(await myAgentsToAdd(r.asha, r.roomId)).toEqual([])
  })
})

describe("only the owner changes an agent", () => {
  it("others can't remove it or change its policy", async () => {
    const r = await room()
    const lekha = await agentOf(r.asha, "Lekha")
    as(r.asha)
    await addRoomAgent({ roomId: r.roomId, agentId: lekha })
    as(r.ravi)
    expect(await removeRoomAgent({ roomId: r.roomId, agentId: lekha })).toEqual({
      error: "Agent not found.",
    })
    expect(
      await setRoomAgentPolicy({
        roomId: r.roomId,
        agentId: lekha,
        invoke: "members",
        dailyCapRupees: 10,
        allowConnectors: true,
      })
    ).toEqual({ error: "Agent not found." })
    expect(await active(r.roomId)).toEqual([{ agent_id: lekha }])
  })
})

describe("leaving takes a person's agents along", () => {
  it("on leaving, and on being removed", async () => {
    const r = await room()
    const lekha = await agentOf(r.asha, "Lekha")
    const mira = await agentOf(r.ravi, "Mira")
    as(r.asha)
    await addRoomAgent({ roomId: r.roomId, agentId: lekha })
    as(r.ravi)
    await addRoomAgent({ roomId: r.roomId, agentId: mira })
    expect(await active(r.roomId)).toHaveLength(2)
    as(r.asha)
    expect(await removeMember({ roomId: r.roomId, userId: r.ravi })).toEqual({ ok: true })
    expect(await active(r.roomId)).toEqual([{ agent_id: lekha }])

    // A third person who joins, adds an agent and leaves
    const meera = await newUser()
    const kavi = await agentOf(meera, "Kavi")
    as(r.asha)
    const invite = await createInvite({ roomId: r.roomId })
    if (!("ok" in invite)) throw new Error(invite.error)
    as(meera)
    await joinRoom(tokenOf(invite.url))
    await addRoomAgent({ roomId: r.roomId, agentId: kavi })
    expect(await leaveRoom(r.roomId)).toEqual({ ok: true })
    expect(await active(r.roomId)).toEqual([{ agent_id: lekha }])
  })
})

describe("RD-17: who sees what an agent costs", () => {
  it("the owner sees today's spend by others; others see only the limit", async () => {
    const r = await room()
    const lekha = await agentOf(r.asha, "Lekha")
    as(r.asha)
    await addRoomAgent({ roomId: r.roomId, agentId: lekha })
    await setRoomAgentPolicy({
      roomId: r.roomId,
      agentId: lekha,
      invoke: "members",
      dailyCapRupees: 2,
      allowConnectors: false,
    })
    // A finished request of Ravi's that cost ₹2.50
    const [task] = await q<{ id: string }>(
      `insert into kriya.tasks (user_id, thread_id, agent_id, status, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
       select $1, bridge_thread_id, $2, 'succeeded', '{}'::jsonb, 'free', 'budget', now() + interval '1 hour', 5, 1000
       from kriya.room_agents where room_id = $3 returning id`,
      [r.asha, lekha, r.roomId]
    )
    await q(
      `insert into kriya.room_invocations (room_id, agent_id, owner_id, requested_by, task_id, status)
       values ($1, $2, $3, $4, $5, 'done')`,
      [r.roomId, lekha, r.asha, r.ravi, task.id]
    )
    await q(
      `insert into kriya.charges (user_id, task_id, plan_id, cost_basis, markup_bps, charge_micro_inr, status)
       values ($1, $2, 'free', 'provider', 0, 2500000, 'final')`,
      [r.asha, task.id]
    )
    const [own] = await roomAgentsFor(r.asha, r.roomId)
    expect(own).toMatchObject({
      mine: true,
      limitReached: true,
      policy: { dailyCapMicroInr: 2000000, spentTodayMicroInr: 2500000 },
    })
    const [theirs] = await roomAgentsFor(r.ravi, r.roomId)
    expect(theirs).toMatchObject({ mine: false, limitReached: true, policy: null })
    expect(JSON.stringify(theirs)).not.toContain("2500000")
    // A non-member sees no agent
    expect(await roomAgentsFor(await newUser(), r.roomId)).toEqual([])
  })
})
