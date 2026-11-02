import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// RT-PRF-01…04 (R5): proof cards built by code from the bridge task's
// episode, room-safe evidence only, independent verification by another
// agent's own verified runs, and the re-check relay. Units first, then end
// to end through runTask on the scripted model and PGlite (no network): the
// web is faked and its reads verify themselves with the page's URL.

const fixtures = vi.hoisted(() => ({ user: "", ip: 0 }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: fixtures.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-forwarded-for": `10.5.0.${++fixtures.ip % 250}` }),
}))
vi.mock("ai", async (original) =>
  (await import("../cloud/agent-seen")).aiMock(await original<typeof import("ai")>())
)
vi.mock("@/lib/models", async (original) =>
  (await import("../cloud/agent-mocks")).modelMock(await original())
)
vi.mock("@/lib/web", async (original) => ({
  ...(await original<typeof import("@/lib/web")>()),
  isWebConfigured: () => true,
  // A read that checked itself: the episode lists it as a verified action
  webFetch: async (url: string) => ({
    url,
    title: "Vendor page",
    markdown: "Price ₹5,999.",
    verification: {
      status: "verified",
      method: "page_check",
      evidence: [{ kind: "url", value: url }],
    },
  }),
}))
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
} from "@/actions/rooms"
import {
  buildCard,
  confirms,
  markVerified,
  normalizeEvidence,
  type ProofCard,
} from "@/lib/rooms/proof"
import { roomRecheckRelay } from "@/lib/rooms/recheck"

import { asUser, createUser } from "../db/harness"
import { reset } from "../cloud/agent-mocks"
import { call, model, say, switches, world, type World } from "../operator/golden/harness"
import { roomsEnv, tokenOf } from "./setup"

const verified = (value: string, kind: "url" | "provider_id" | "file" = "url") => ({
  status: "verified" as const,
  method: "page_check" as const,
  evidence: [{ kind, value }],
})
const action = (tool: string, v: ReturnType<typeof verified>) => ({
  executionId: "x",
  tool,
  title: `Did ${tool}`,
  risk: "R0",
  verification: v,
})

describe("RT-PRF-01: the card comes from the episode only", () => {
  it("copies done items and counts claims and checks; nothing else", () => {
    const card = buildCard({
      done: [action("web_fetch", verified("https://a.example/p"))],
      unconfirmed: [{ claim: "Booked a table", reason: "No run." }],
      checks: [
        { status: "supported" },
        { status: "unsupported" },
        { status: "supported" },
      ],
    })
    expect(card).toEqual({
      kind: "proof",
      done: [
        {
          title: "Did web_fetch",
          status: "verified",
          method: "page_check",
          evidence: [{ kind: "url", value: "https://a.example/p" }],
        },
      ],
      unconfirmed: 1,
      checks: { supported: 2, unsupported: 1 },
      verifiedBy: [],
    })
    // Nothing done, claimed or checked: no card
    expect(buildCard({ done: [], unconfirmed: [], checks: [] })).toBeNull()
    expect(buildCard(null)).toBeNull()
  })
})

describe("RT-PRF-02: room-safe evidence", () => {
  it("drops file evidence and keeps url and provider_id; no ids of the owner's", () => {
    const card = buildCard({
      done: [
        {
          ...action("x", verified("f")),
          verification: {
            status: "verified",
            method: "api_readback",
            evidence: [
              { kind: "file", value: "file-uuid" },
              { kind: "url", value: "https://github.com/o/r/pull/4" },
              { kind: "provider_id", value: "o/r#4" },
            ],
          },
        },
      ],
      unconfirmed: [],
      checks: [],
    })!
    expect(card.done[0].evidence).toEqual([
      { kind: "url", value: "https://github.com/o/r/pull/4" },
      { kind: "provider_id", value: "o/r#4" },
    ])
    expect(JSON.stringify(card)).not.toMatch(/file-uuid|executionId|taskId/)
    // Kriya's own row ids aren't public: a saved schedule's id stays home
    const own = buildCard({
      done: [action("schedule_create", verified("schedule-row-id", "provider_id"))],
      unconfirmed: [],
      checks: [],
    })!
    expect(own.done[0].evidence).toEqual([])
  })
})

describe("RT-PRF-03: matching (units)", () => {
  const card = buildCard({
    done: [action("web_fetch", verified("https://Shop.example/item/"))],
    unconfirmed: [],
    checks: [],
  }) as ProofCard
  it("same page however written: case of the host, fragment, trailing slash", () => {
    expect(
      normalizeEvidence({ kind: "url", value: "HTTPS://shop.EXAMPLE/item#top" })
    ).toBe(normalizeEvidence({ kind: "url", value: "https://shop.example/item/" }))
    expect(
      confirms(card, [action("web_fetch", verified("https://shop.example/item"))])
    ).toBe(true)
  })
  it("a different page, an unverified run or a file never confirms", () => {
    expect(
      confirms(card, [action("web_fetch", verified("https://shop.example/other"))])
    ).toBe(false)
    expect(
      confirms(card, [
        {
          ...action("web_fetch", verified("https://shop.example/item")),
          verification: {
            status: "unverified",
            method: "page_check",
            evidence: [{ kind: "url", value: "https://shop.example/item" }],
          },
        },
      ])
    ).toBe(false)
    expect(
      confirms(card, [action("x", verified("https://shop.example/item", "file"))])
    ).toBe(false)
  })
})

/* ── end to end ── */

let w: World
let ravi: string
let roomId: string
const as = (user: string) => (fixtures.user = user)

async function setUp() {
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
  as(w.user)
  await addRoomAgent({ roomId, agentId: "a1" })
}

async function ask(by: string, agentId: string, body: string, replyTo?: string) {
  as(by)
  const posted = await postMessage({ roomId, body, mentions: [agentId], replyTo })
  if (!("ok" in posted)) throw new Error(posted.error)
  return w.runQueued()
}

const agentMessages = () =>
  w.q<{ id: string; agent_id: string; parts: { proof?: ProofCard } }>(
    "select id, agent_id, parts from kriya.room_messages where room_id = $1 and author_kind = 'agent' order by seq",
    [roomId]
  )
const systemLines = async () =>
  (
    await w.q<{ body: string }>(
      "select body from kriya.room_messages where room_id = $1 and author_kind = 'system' order by seq",
      [roomId]
    )
  ).map((r) => r.body)

// Lekha reads a page (verified by its own check) and answers
const reads = (url: string, text: string) => (run: string, results: number) =>
  !run.includes("Request:")
    ? say("Done.")
    : results === 0
      ? call("web_fetch", { url }, "c1")
      : say(text)

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
    KRIYA_NEXT_RECHECK: undefined,
  })
  model.script = () => say("Done.")
})

describe("RT-PRF-01 end to end", () => {
  it("the posted reply carries the card from its run records", async () => {
    await setUp()
    model.script = reads(
      "https://shop.example/item",
      "A is cheapest. I sent the email to the vendor."
    )
    await ask(w.user, "a1", "@Lekha compare")
    const [message] = await agentMessages()
    expect(message.parts.proof).toMatchObject({
      kind: "proof",
      done: [
        {
          status: "verified",
          method: "page_check",
          evidence: [{ kind: "url", value: "https://shop.example/item" }],
        },
      ],
      verifiedBy: [],
    })
    // "sent the email" had no run: counted as not confirmed, not as done
    expect(message.parts.proof!.unconfirmed).toBeGreaterThanOrEqual(1)
  })
})

describe("RT-PRF-03 end to end: independent verification", () => {
  it("another owner's agent with the same verified evidence marks the card", async () => {
    await setUp()
    model.script = reads("https://shop.example/item", "A is cheapest.")
    await ask(w.user, "a1", "@Lekha compare")
    const [card] = await agentMessages()

    // Ravi asks his own agent about the card; Mira checks the same page
    model.script = reads("https://SHOP.example/item/", "Confirmed: ₹5,999.")
    await ask(ravi, "m1", "@Mira verify this", card.id)
    const [original, mira] = await agentMessages()
    expect(mira.agent_id).toBe("m1")
    expect(original.parts.proof!.verifiedBy).toEqual([
      { agentId: "m1", agentName: "Mira", ownerName: "Ravi", at: expect.any(String) },
    ])
    expect((await systemLines()).at(-1)).toBe(
      "Mira (Ravi's agent) independently verified a card's actions."
    )
    // The request Mira read carried the card's claims
    const [bridge] = await w.q<{ parts: { text: string }[] }>(
      `select parts from kriya.messages where user_id = $1 and role = 'user'
       and metadata ->> 'channel' = 'room' order by created_at desc limit 1`,
      [ravi]
    )
    expect(bridge.parts[0].text).toContain("https://shop.example/item")
  })

  it("two agents verifying at once are both recorded (no lost update)", async () => {
    await setUp()
    model.script = reads("https://shop.example/item", "A is cheapest.")
    await ask(w.user, "a1", "@Lekha compare")
    const [card] = await agentMessages()
    const verifier = [action("web_fetch", verified("https://shop.example/item"))]
    const results = await Promise.all(
      ["v1", "v2", "v3"].map((agentId) =>
        markVerified({
          roomId,
          cardMessageId: card.id,
          verifier,
          agentId,
          agentName: agentId,
          ownerName: "Ravi",
        })
      )
    )
    expect(results).toEqual([true, true, true])
    const [after] = await agentMessages()
    expect(after.parts.proof!.verifiedBy.map((v) => v.agentId).sort()).toEqual([
      "v1",
      "v2",
      "v3",
    ])
  })

  it("different evidence changes nothing", async () => {
    await setUp()
    model.script = reads("https://shop.example/item", "A is cheapest.")
    await ask(w.user, "a1", "@Lekha compare")
    const [card] = await agentMessages()
    model.script = reads("https://other.example/", "Couldn't find it.")
    await ask(ravi, "m1", "@Mira verify this", card.id)
    const [original] = await agentMessages()
    expect(original.parts.proof!.verifiedBy).toEqual([])
  })

  it("a reply can point only at a card in the same room", async () => {
    await setUp()
    as(ravi)
    expect(
      await postMessage({
        roomId,
        body: "hi",
        replyTo: "00000000-0000-4000-8000-000000000000",
      })
    ).toEqual({ error: "That card isn't in this room any more." })
  })
})

describe("RT-PRF-04: the re-check relay", () => {
  it("posts one line per re-check of a card's run; never twice", async () => {
    await setUp()
    model.script = reads("https://shop.example/item", "A is cheapest.")
    const taskId = await ask(w.user, "a1", "@Lekha compare")
    const [execution] = await w.q<{ id: string }>(
      "select id from kriya.tool_executions where task_id = $1 and tool_name = 'web_fetch'",
      [taskId]
    )
    await w.q(
      `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
       values ($1, $2, $3, 'recheck', 'failed')`,
      [w.user, taskId, execution.id]
    )
    expect(await roomRecheckRelay()).toEqual({ posted: 1 })
    expect((await systemLines()).at(-1)).toMatch(/^Re-checked “.+”: now failed\.$/)
    expect(await roomRecheckRelay()).toEqual({ posted: 0 })
  })

  it("a reply that was never in the room gets no line", async () => {
    await setUp()
    model.script = reads("https://shop.example/item", "A is cheapest.")
    const taskId = await ask(w.user, "a1", "@Lekha compare")
    await w.q("update kriya.room_messages set deleted_at = now() where task_id = $1", [
      taskId,
    ])
    const [execution] = await w.q<{ id: string }>(
      "select id from kriya.tool_executions where task_id = $1",
      [taskId]
    )
    await w.q(
      `insert into kriya.delivery_checks (user_id, task_id, execution_id, kind, status)
       values ($1, $2, $3, 'recheck', 'verified')`,
      [w.user, taskId, execution.id]
    )
    expect(await roomRecheckRelay()).toEqual({ posted: 0 })
  })
})
