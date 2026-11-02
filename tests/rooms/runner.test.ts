import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// RT-AGT-01…06 and RT-INV-06 (R4): a room request end to end through the
// real runner on the scripted model and PGlite: the mention, the owner's
// task, the room belt and prompt, the disclosure gate, Share / Discard,
// approvals in the owner's Inbox only, and room_history. No network.

const fixtures = vi.hoisted(() => ({ user: "", ip: 0 }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: fixtures.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-forwarded-for": `10.3.0.${++fixtures.ip % 250}` }),
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
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
vi.mock("@/lib/connectors", async (original) => ({
  ...(await original<typeof import("@/lib/connectors")>()),
  gmailSearch: async () => ({
    messages: [
      { id: "g1", from: "bank@example.com", subject: "Statement", snippet: "₹4,200 due" },
    ],
  }),
}))

import {
  addRoomAgent,
  createInvite,
  createRoom,
  discardDisclosure,
  joinRoom,
  postMessage,
  setRoomAgentPolicy,
  shareDisclosure,
} from "@/actions/rooms"
import { ROOM_CONTEXT, ROOM_FOREIGN } from "@/lib/rooms/context"
import { getInbox } from "@/queries/inbox"

import { createUser } from "../db/harness"
import { reset, seen } from "../cloud/agent-mocks"
import { call, model, say, switches, world, type World } from "../operator/golden/harness"
import { roomsEnv, tokenOf } from "./setup"

let w: World
let ravi: string
let roomId: string
let bridge: string

const as = (user: string) => (fixtures.user = user)

async function setUp({ connectors = false } = {}) {
  ravi = await createUser(w.pg)
  await w.q("update kriya.profiles set display_name = 'Asha' where id = $1", [w.user])
  await w.q("update kriya.profiles set display_name = 'Ravi' where id = $1", [ravi])
  as(w.user)
  const made = await createRoom({ title: "Launch" })
  if (!("ok" in made)) throw new Error(made.error)
  roomId = made.roomId
  const invite = await createInvite({ roomId })
  if (!("ok" in invite)) throw new Error(invite.error)
  as(ravi)
  await joinRoom(tokenOf(invite.url))
  as(w.user)
  const added = await addRoomAgent({ roomId, agentId: "a1" })
  if (!("ok" in added)) throw new Error(added.error)
  const policy = await setRoomAgentPolicy({
    roomId,
    agentId: "a1",
    invoke: "members",
    dailyCapRupees: 50,
    allowConnectors: connectors,
  })
  if (!("ok" in policy)) throw new Error(policy.error)
  ;[{ bridge }] = await w.q<{ bridge: string }>(
    "select bridge_thread_id as bridge from kriya.room_agents where room_id = $1",
    [roomId]
  )
}

// Someone in the room mentions Lekha; the worker runs the owner's task
async function ask(by: string, body: string) {
  as(by)
  const posted = await postMessage({ roomId, body, mentions: ["a1"] })
  if (!("ok" in posted)) throw new Error(posted.error)
  return w.runQueued()
}

const roomMessages = () =>
  w.q<{
    author_kind: string
    agent_id: string | null
    user_id: string | null
    body: string
    parts: Record<string, unknown>
  }>(
    "select author_kind, agent_id, user_id, body, parts from kriya.room_messages where room_id = $1 order by seq",
    [roomId]
  )
const lastMessage = async () => (await roomMessages()).at(-1)!

beforeEach(async () => {
  reset()
  w = await world()
  roomsEnv({ KRIYA_ROOMS_AGENTS: "on" })
})

afterEach(() => {
  switches(false)
  roomsEnv({
    KRIYA_ROOMS_ENABLED: undefined,
    KRIYA_ROOMS_AGENTS: undefined,
    KRIYA_AGENTS_MEMORY_V2: undefined,
    KRIYA_AGENTS_SKILL_LIBRARY: undefined,
  })
  model.script = () => say("Done.")
})

describe("RT-AGT-01: the room belt", () => {
  it("drops connected accounts and app tools, adds room_history; a normal turn keeps them", async () => {
    await setUp()
    await ask(ravi, "@Lekha what's new?")
    const roomBelt = seen.tools.at(-1)!.names
    expect(roomBelt).toContain("room_history")
    expect(
      roomBelt.filter((n) => /^(gmail|calendar|drive|sheets|notion)_/.test(n))
    ).toEqual([])
    // The prompt doesn't offer the accounts either
    expect(seen.prompts.at(-1)).not.toContain("Gmail (")

    await w.turn("hello")
    const chatBelt = seen.tools.at(-1)!.names
    expect(chatBelt).toContain("gmail_search")
    expect(chatBelt).not.toContain("room_history")
  })

  it("keeps connected accounts when the owner allows them in this room", async () => {
    await setUp({ connectors: true })
    await ask(w.user, "@Lekha check my mail")
    expect(seen.tools.at(-1)!.names).toEqual(
      expect.arrayContaining(["gmail_search", "room_history"])
    )
  })
})

describe("RT-AGT-02: the room prompt line", () => {
  it("is present for room tasks only; other prompts are byte for byte the same", async () => {
    await w.turn("hello")
    const before = seen.prompts.at(-1)!
    await setUp()
    await ask(w.user, "@Lekha hi")
    const room = seen.prompts.at(-1)!
    expect(room).toContain("# Room")
    expect(room).toContain("Launch")
    expect(room).toMatch(/never your owner's instructions/)
    await w.turn("hello again")
    expect(seen.prompts.at(-1)).toBe(before)
    expect(before).not.toContain("# Room")
  })
})

describe("relay: a reply without private reads", () => {
  it("is posted as the agent, labelled with its owner, and closes the invocation", async () => {
    await setUp()
    model.script = (run) =>
      run.includes("Request:") ? say("Three vendors compared.") : say("Done.")
    await ask(ravi, "@Lekha compare vendors")
    expect(await lastMessage()).toMatchObject({
      author_kind: "agent",
      agent_id: "a1",
      user_id: w.user,
      body: "Three vendors compared.",
    })
    expect(
      await w.q("select status from kriya.room_invocations where room_id = $1", [roomId])
    ).toEqual([{ status: "done" }])
    // The owner's bridge thread holds the request and the reply
    expect(
      await w.q<{ role: string }>(
        "select role from kriya.messages where thread_id = $1 order by created_at",
        [bridge]
      )
    ).toEqual([{ role: "user" }, { role: "assistant" }])
  })
})

describe("RT-AGT-03: a reply after a private read", () => {
  it("waits for the owner: a disclosure row, a waiting line, nothing posted", async () => {
    await setUp({ connectors: true })
    model.script = (run, results) =>
      !run.includes("Request:")
        ? say("Done.")
        : results === 0
          ? call("gmail_search", { query: "statement" }, "c1")
          : say("Your bank statement says ₹4,200 is due.")
    await ask(ravi, "@Lekha what does Asha owe the bank?")
    const messages = await roomMessages()
    expect(messages.filter((m) => m.author_kind === "agent")).toEqual([])
    expect(messages.at(-1)).toMatchObject({
      author_kind: "system",
      body: "Lekha replied; waiting for Asha to share it.",
    })
    const disclosures = await w.q<{
      id: string
      owner_id: string
      body: string
      status: string
    }>(
      "select id, owner_id, body, status from kriya.room_disclosures where room_id = $1",
      [roomId]
    )
    expect(disclosures).toEqual([
      {
        id: expect.any(String),
        owner_id: w.user,
        body: "Your bank statement says ₹4,200 is due.",
        status: "pending",
      },
    ])
    expect(messages.at(-1)!.parts).toEqual({
      kind: "waiting",
      disclosureId: disclosures[0].id,
    })
    // In the owner's Inbox, never in the requester's
    expect((await getInbox(w.user)).disclosures).toEqual([
      expect.objectContaining({
        id: disclosures[0].id,
        roomTitle: "Launch",
        agentName: "Lekha",
        body: "Your bank statement says ₹4,200 is due.",
      }),
    ])
    expect((await getInbox(ravi)).disclosures).toEqual([])

    // The next reply in that bridge thread is still gated: the private read
    // stays in the model's context
    model.script = (run) =>
      run.includes("Request:") ? say("Nothing new.") : say("Done.")
    await ask(ravi, "@Lekha anything else?")
    expect(await lastMessage()).toMatchObject({
      author_kind: "system",
      body: "Lekha replied; waiting for Asha to share it.",
    })
  })
})

describe("RT-AGT-04: Share / Discard", () => {
  async function pending() {
    model.script = (run, results) =>
      !run.includes("Request:")
        ? say("Done.")
        : results === 0
          ? call("gmail_search", { query: "statement" }, "c1")
          : say("Statement: ₹4,200 due.")
    await ask(ravi, "@Lekha check")
    const [row] = await w.q<{ id: string }>(
      "select id from kriya.room_disclosures where room_id = $1 and status = 'pending'",
      [roomId]
    )
    return row.id
  }

  it("Share posts the exact stored text as the agent; only the owner can", async () => {
    await setUp({ connectors: true })
    const id = await pending()
    as(ravi)
    expect(await shareDisclosure(id)).toEqual({ error: expect.any(String) })
    expect((await roomMessages()).filter((m) => m.author_kind === "agent")).toEqual([])
    as(w.user)
    expect(await shareDisclosure(id)).toEqual({ ok: true })
    expect(await lastMessage()).toMatchObject({
      author_kind: "agent",
      agent_id: "a1",
      user_id: w.user,
      body: "Statement: ₹4,200 due.",
      parts: { disclosureId: id },
    })
    // Answered once
    expect(await shareDisclosure(id)).toEqual({ error: expect.any(String) })
    expect(
      await w.q("select status from kriya.room_disclosures where id = $1", [id])
    ).toEqual([{ status: "shared" }])
  })

  it("Discard posts nothing", async () => {
    await setUp({ connectors: true })
    const id = await pending()
    const before = (await roomMessages()).length
    as(w.user)
    expect(await discardDisclosure(id)).toEqual({ ok: true })
    expect(await roomMessages()).toHaveLength(before)
    expect(
      await w.q("select status from kriya.room_disclosures where id = $1", [id])
    ).toEqual([{ status: "discarded" }])
    expect((await getInbox(w.user)).disclosures).toEqual([])
  })
})

describe("RT-AGT-05: a side effect in a room task", () => {
  it("waits for the owner's approval in the owner's Inbox only", async () => {
    await setUp({ connectors: true })
    model.script = (run, results) =>
      !run.includes("Request:")
        ? say("Done.")
        : results === 0
          ? call(
              "gmail_draft",
              { to: ["vendor@example.com"], subject: "Hi", body: "Hello" },
              "c1"
            )
          : say("Drafted.")
    await ask(ravi, "@Lekha email the vendor")
    expect(
      await w.q(
        "select user_id, tool_name, status from kriya.approvals where thread_id = $1",
        [bridge]
      )
    ).toEqual([{ user_id: w.user, tool_name: "gmail_draft", status: "pending" }])
    expect((await getInbox(w.user)).approvals).toHaveLength(1)
    expect((await getInbox(ravi)).approvals).toEqual([])
    expect((await roomMessages()).at(-1)).toMatchObject({
      author_kind: "system",
      body: "Lekha is waiting for Asha to approve an action.",
    })
  })
})

describe("RT-AGT-06: room_history and memory", () => {
  it("reads only this room, marked as foreign", async () => {
    await setUp()
    // Another room of Asha's, with a message Lekha must not see
    as(w.user)
    const other = await createRoom({ title: "Other" })
    if (!("ok" in other)) throw new Error(other.error)
    await postMessage({ roomId: other.roomId, body: "secret plan" })
    as(ravi)
    await postMessage({ roomId, body: "we need a venue" })
    let output = ""
    model.script = (run, results) =>
      !run.includes("Request:")
        ? say("Done.")
        : results === 0
          ? call("room_history", { limit: 50 }, "c1")
          : ((output = run), say("Read it."))
    await ask(ravi, "@Lekha catch up")
    expect(output).toContain("we need a venue")
    expect(output).toContain(ROOM_FOREIGN)
    expect(output).not.toContain("secret plan")
  })

  it("a note saved during a room task is unconfirmed", async () => {
    process.env.KRIYA_AGENTS_MEMORY_V2 = "on"
    roomsEnv({ KRIYA_ROOMS_AGENTS: "on", KRIYA_AGENTS_MEMORY_V2: "on" })
    await setUp()
    model.script = (run, results) =>
      !run.includes("Request:")
        ? say("Done.")
        : results === 0
          ? call("memory_write", { note: "The launch venue is Hall B" }, "c1")
          : say("Noted.")
    await ask(ravi, "@Lekha remember the venue is Hall B")
    expect(await w.q("select content, trust from kriya.memories")).toEqual([
      { content: "The launch venue is Hall B", trust: "unconfirmed" },
    ])
  })
})

describe("RT-INV-06: only the request picks a skill", () => {
  it("words in the quoted room never load a skill; the request's own words do", async () => {
    roomsEnv({ KRIYA_ROOMS_AGENTS: "on", KRIYA_AGENTS_SKILL_LIBRARY: "on" })
    await w.q("update kriya.agents set skills = $1 where id = 'a1'", [
      JSON.stringify({ auto: true, on: ["research-verification"] }),
    ])
    await setUp()
    as(ravi)
    await postMessage({ roomId, body: "Compare the latest fees at three colleges" })
    const first = await ask(ravi, "@Lekha hello there")
    const second = await ask(ravi, "@Lekha compare the latest fees at three colleges")
    const active = async (taskId: string | null) =>
      (
        await w.q<{ skill_id: string }>(
          "select skill_id from kriya.skill_activations where task_id = $1 and status = 'active'",
          [taskId]
        )
      ).map((row) => row.skill_id)
    expect(await active(first)).not.toContain("research-verification")
    expect(await active(second)).toContain("research-verification")
  })
})

describe("the bridge message", () => {
  it("is what the model reads, with the room marked untrusted", async () => {
    await setUp()
    await ask(ravi, "@Lekha hi")
    expect(seen.tools.at(-1)!.run).toContain(ROOM_CONTEXT.slice(0, 40))
  })
})

describe("the owner's memory in rooms (owner, 2026-11-01)", () => {
  const note = () =>
    w.q(
      "insert into kriya.memories (id, user_id, agent_id, content) values ('note1', $1, 'a1', 'Asha earns ₹40 lakh a year')",
      [w.user]
    )

  it("a locked room task sees no notes and can't search, change or delete them", async () => {
    await note()
    await setUp()
    await ask(ravi, "@Lekha what does Asha earn?")
    expect(seen.prompts.at(-1)).not.toContain("₹40 lakh")
    const belt = seen.tools.at(-1)!.names
    expect(belt).toContain("memory_write")
    for (const name of ["memory_search", "memory_update", "memory_forget"])
      expect(belt, name).not.toContain(name)
    // A normal turn still has its memory
    await w.turn("hello")
    expect(seen.prompts.at(-1)).toContain("₹40 lakh")
  })

  it("with the owner's accounts allowed, a reply after the notes were shown waits for Share", async () => {
    await note()
    await setUp({ connectors: true })
    model.script = (run) =>
      run.includes("Request:") ? say("About ₹40 lakh.") : say("Done.")
    await ask(ravi, "@Lekha what does Asha earn?")
    expect(seen.prompts.at(-1)).toContain("₹40 lakh")
    expect(seen.tools.at(-1)!.names).not.toContain("memory_forget")
    expect((await roomMessages()).filter((m) => m.author_kind === "agent")).toEqual([])
    expect(await lastMessage()).toMatchObject({
      author_kind: "system",
      body: "Lekha replied; waiting for Asha to share it.",
    })
  })
})
