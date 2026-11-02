import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// RT-CND-01…04 (R6, RD-12): agent-to-agent turns decided by code. A reply
// that names another room agent with @ sets off its turn only within the
// budget, never for the agent that spoke, never for a repeat, and only if
// the named agent's policy allows the person who started the chain; Stop
// agents pauses them for ten minutes. Through runTask on the scripted model
// and PGlite; no network.

const fixtures = vi.hoisted(() => ({ user: "", ip: 0 }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: fixtures.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-forwarded-for": `10.7.0.${++fixtures.ip % 250}` }),
}))
vi.mock("ai", async (original) =>
  (await import("../cloud/agent-seen")).aiMock(await original<typeof import("ai")>())
)
vi.mock("@/lib/models", async (original) =>
  (await import("../cloud/agent-mocks")).modelMock(await original())
)
vi.mock("@/lib/web", async (original) =>
  (await import("../cloud/agent-mocks")).webMock(await original())
)
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))

import {
  addRoomAgent,
  createInvite,
  createRoom,
  joinRoom,
  postMessage,
  setRoomAgentPolicy,
  stopAgents,
} from "@/actions/rooms"
import { namedAgents, normalizeReply } from "@/lib/rooms/conductor"

import { asUser, createUser } from "../db/harness"
import { reset } from "../cloud/agent-mocks"
import { model, say, switches, world, type World } from "../operator/golden/harness"
import { roomsEnv, tokenOf } from "./setup"

describe("the conductor's text rules (units)", () => {
  const roster = [
    { agentId: "a1", name: "Lekha" },
    { agentId: "m1", name: "Mira" },
    { agentId: "x1", name: "Twin" },
    { agentId: "x2", name: "Twin" },
  ]
  it("finds whole @names, skips the speaker and names two agents share", () => {
    expect(
      namedAgents("@Mira, can you check?", roster, "a1").map((a) => a.agentId)
    ).toEqual(["m1"])
    expect(namedAgents("@Miranda isn't here; mail@Mira.com", roster, "a1")).toEqual([])
    expect(namedAgents("@Lekha talking to myself", roster, "a1")).toEqual([])
    expect(namedAgents("@Twin which one?", roster, "a1")).toEqual([])
  })
  it("compares replies without names, case or spacing", () => {
    expect(normalizeReply("@Mira  Please check the PRICE.")).toBe(
      normalizeReply("@Lekha please check the price")
    )
    expect(normalizeReply("Price is ₹5,999")).not.toBe(normalizeReply("Price is ₹6,200"))
  })
})

let w: World
let ravi: string
let roomId: string
const as = (user: string) => (fixtures.user = user)

// Asha owns Lekha (a1), Ravi owns Mira (m1); both let room members ask,
// up to ₹50 a day, unless a test says otherwise
async function setUp({ miraOwnerOnly = false } = {}) {
  ravi = await createUser(w.pg)
  await w.q("update kriya.profiles set display_name = 'Asha' where id = $1", [w.user])
  await w.q("update kriya.profiles set display_name = 'Ravi' where id = $1", [ravi])
  await asUser(w.pg, ravi, (tx) =>
    tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('m1', $1, 'Mira', 'r', 'g')",
      [ravi]
    )
  )
  as(w.user)
  const made = await createRoom({ title: "Launch" })
  if (!("ok" in made)) throw new Error(made.error)
  roomId = made.roomId
  const invite = await createInvite({ roomId })
  if (!("ok" in invite)) throw new Error(invite.error)
  as(ravi)
  await joinRoom(tokenOf(invite.url))
  await addRoomAgent({ roomId, agentId: "m1" })
  if (!miraOwnerOnly)
    await setRoomAgentPolicy({
      roomId,
      agentId: "m1",
      invoke: "members",
      dailyCapRupees: 50,
      allowConnectors: false,
    })
  as(w.user)
  await addRoomAgent({ roomId, agentId: "a1" })
  await setRoomAgentPolicy({
    roomId,
    agentId: "a1",
    invoke: "members",
    dailyCapRupees: 50,
    allowConnectors: false,
  })
}

// Each agent's scripted reply, keyed by whom the request names first: a
// person's "@Lekha …", or a follow-on's request, which is the asking
// agent's reply ("@Mira …")
function replies(by: Record<string, string>) {
  model.script = (run) => {
    const at = run.lastIndexOf("Request:")
    if (at < 0) return say("Done.")
    const name = /@(\w+)/.exec(run.slice(at))?.[1]
    return say((name && by[name]) ?? "Done.")
  }
}

// Runs queued tasks until none is left; returns how many ran
async function drain() {
  let ran = 0
  while ((await w.runQueued()) !== null) ran++
  return ran
}

const lines = async () =>
  (
    await w.q<{ author_kind: string; agent_id: string | null; body: string }>(
      "select author_kind, agent_id, body from kriya.room_messages where room_id = $1 order by seq",
      [roomId]
    )
  ).map((m) => (m.author_kind === "agent" ? `${m.agent_id}: ${m.body}` : m.body))
const invocations = () =>
  w.q<{ agent_id: string; requested_by: string; chain_depth: number; status: string }>(
    "select agent_id, requested_by, chain_depth, status from kriya.room_invocations where room_id = $1 order by created_at",
    [roomId]
  )

beforeEach(async () => {
  reset()
  w = await world()
  roomsEnv({ KRIYA_ROOMS_AGENTS: "on", KRIYA_ROOMS_AGENT_TURN_BUDGET: undefined })
})
afterEach(() => {
  switches(false)
  roomsEnv({
    KRIYA_ROOMS_ENABLED: undefined,
    KRIYA_ROOMS_AGENTS: undefined,
    KRIYA_ROOMS_AGENT_TURN_BUDGET: undefined,
  })
  model.script = () => say("Done.")
})

async function ask(by: string, agentId: string, body: string) {
  as(by)
  const posted = await postMessage({ roomId, body, mentions: [agentId] })
  if (!("ok" in posted)) throw new Error(posted.error)
}

describe("RT-CND-01: the turn budget", () => {
  it("a follow-on runs within the budget and is refused at it", async () => {
    roomsEnv({ KRIYA_ROOMS_AGENTS: "on", KRIYA_ROOMS_AGENT_TURN_BUDGET: "2" })
    await setUp()
    replies({ Lekha: "@Mira can you check the price?", Mira: "@Lekha it is ₹5,999." })
    await ask(w.user, "a1", "@Lekha compare vendors")
    expect(await drain()).toBe(2)
    expect(await invocations()).toEqual([
      { agent_id: "a1", requested_by: w.user, chain_depth: 0, status: "done" },
      { agent_id: "m1", requested_by: w.user, chain_depth: 1, status: "done" },
    ])
    const all = await lines()
    expect(all).toContain("a1: @Mira can you check the price?")
    expect(all).toContain("Mira is working…")
    expect(all.at(-1)).toBe(
      "Agents reached the limit of 2 turns for one message. Ask again to carry on."
    )
    // The follow-on's request names the asking agent
    const [bridge] = await w.q<{ parts: { text: string }[] }>(
      `select parts from kriya.messages where user_id = $1 and role = 'user'
       and metadata ->> 'channel' = 'room' order by created_at desc limit 1`,
      [ravi]
    )
    expect(bridge.parts[0].text).toMatch(
      /^\[Room: Launch\] Requested by Lekha, Asha's agent/
    )
  })
})

describe("RT-CND-02: no self-follow-on, no repeats", () => {
  it("an agent naming itself sets nothing off", async () => {
    await setUp()
    replies({ Lekha: "@Lekha I'll keep going myself." })
    await ask(w.user, "a1", "@Lekha go")
    expect(await drain()).toBe(1)
    expect(await invocations()).toHaveLength(1)
  })

  it("a reply that repeats an earlier one in the chain ends it", async () => {
    await setUp()
    replies({
      Lekha: "@Mira please check the price.",
      Mira: "@Lekha Please check the PRICE",
    })
    await ask(w.user, "a1", "@Lekha compare")
    expect(await drain()).toBe(2)
    expect((await lines()).at(-1)).toBe("Agents stopped: they were repeating each other.")
    expect(await invocations()).toHaveLength(2)
  })
})

describe("RT-CND-03: the policy of the chain's first person", () => {
  it("Mira, answering only to Ravi, isn't set off by Asha's chain", async () => {
    await setUp({ miraOwnerOnly: true })
    replies({ Lekha: "@Mira over to you." })
    await ask(w.user, "a1", "@Lekha start")
    expect(await drain()).toBe(1)
    expect((await lines()).at(-1)).toBe("Mira answers only to Ravi.")
    expect((await invocations()).at(-1)).toMatchObject({
      agent_id: "m1",
      requested_by: w.user,
      chain_depth: 1,
      status: "refused",
    })
  })

  it("…but is, in a chain Ravi started", async () => {
    await setUp({ miraOwnerOnly: true })
    replies({ Lekha: "@Mira over to you.", Mira: "Checked: ₹5,999." })
    await ask(ravi, "a1", "@Lekha start")
    expect(await drain()).toBe(2)
    expect((await invocations()).at(-1)).toMatchObject({
      agent_id: "m1",
      requested_by: ravi,
      chain_depth: 1,
      status: "done",
    })
  })
})

describe("RT-CND-04: Stop agents", () => {
  it("any member pauses follow-ons and requests for ten minutes", async () => {
    await setUp()
    replies({ Lekha: "@Mira over to you." })
    await ask(w.user, "a1", "@Lekha start")
    // Ravi, a plain member, presses Stop while Lekha works
    as(ravi)
    expect(await stopAgents(roomId)).toEqual({ ok: true, until: expect.any(String) })
    const [room] = await w.q<{ minutes: number }>(
      "select round(extract(epoch from agents_paused_until - now()) / 60)::int as minutes from kriya.rooms where id = $1",
      [roomId]
    )
    expect(room.minutes).toBe(10)
    expect(await drain()).toBe(1)
    const all = await lines()
    expect(all).toContain("Ravi stopped the agents for 10 minutes.")
    expect(all.at(-1)).toBe("Agents are paused in this room for now.")
    // People's requests wait too (check_room_invocation, R1)
    await ask(w.user, "a1", "@Lekha again")
    expect((await lines()).at(-1)).toBe("Agents are paused in this room for now.")
    // Ten minutes later
    await w.q(
      "update kriya.rooms set agents_paused_until = now() - interval '1 second' where id = $1",
      [roomId]
    )
    await ask(w.user, "a1", "@Lekha again")
    expect((await lines()).at(-1)).toBe("Lekha is working…")
  })

  it("stops the presser's own agent's running task, never another owner's", async () => {
    await setUp()
    replies({ Mira: "Done." })
    await ask(ravi, "m1", "@Mira start")
    as(ravi)
    await stopAgents(roomId)
    expect(
      await w.q(
        "select status from kriya.tasks where user_id = $1 and input ->> 'channel' = 'room'",
        [ravi]
      )
    ).toEqual([{ status: "canceled" }])

    // Asha's Lekha, working, is left alone by Ravi's Stop
    await w.q("update kriya.rooms set agents_paused_until = null where id = $1", [roomId])
    await ask(w.user, "a1", "@Lekha start")
    as(ravi)
    await stopAgents(roomId)
    expect(
      await w.q(
        "select status from kriya.tasks where user_id = $1 and input ->> 'channel' = 'room'",
        [w.user]
      )
    ).toEqual([{ status: "queued" }])
  })

  it("needs membership", async () => {
    await setUp()
    as(await createUser(w.pg))
    expect(await stopAgents(roomId)).toEqual({ error: "Room not found." })
  })
})
