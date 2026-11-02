import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { TestDb } from "../db/harness"
import { roomsDb, roomsEnv, tokenOf } from "./setup"

// PX-03, track R's part: /api/events tells a person in-app when someone
// mentions them in a room (rooms.enabled) and when an agent's reply waits
// for their "Share in room" (rooms.agents). Through RLS: nobody hears of
// another person's mentions or held replies; off = nothing.

vi.mock("server-only", () => ({}))
const session = vi.hoisted(() => ({ user: "", ip: 0 }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: session.user, email: null }),
  authenticate: async () => ({ id: session.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `10.6.0.${++session.ip % 250}` }),
}))

import { createInvite, createRoom, joinRoom, postMessage } from "@/actions/rooms"
import { GET } from "@/app/api/events/route"
import type { KriyaEvent } from "@/lib/events"

let pg: TestDb
let newUser: () => Promise<string>
const as = (user: string) => (session.user = user)

// The first batch the stream sends for this person
async function eventsFor(user: string) {
  as(user)
  const response = await GET(new Request("https://kriya.test/api/events"))
  const reader = response.body!.getReader()
  let text = ""
  while (!text.includes(": keep-alive")) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  await reader.cancel()
  return [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]) as KriyaEvent)
}

async function room() {
  const asha = await newUser()
  const ravi = await newUser()
  await pg.query("update kriya.profiles set display_name = 'Asha' where id = $1", [asha])
  as(asha)
  const made = await createRoom({ title: "Launch" })
  if (!("ok" in made)) throw new Error(made.error)
  const invite = await createInvite({ roomId: made.roomId })
  if (!("ok" in invite)) throw new Error(invite.error)
  as(ravi)
  await joinRoom(tokenOf(invite.url))
  return { asha, ravi, roomId: made.roomId }
}

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await roomsDb())
})
beforeEach(() =>
  roomsEnv({
    KRIYA_ROOMS_ENABLED: "on",
    KRIYA_ROOMS_AGENTS: undefined,
    KRIYA_AGENTS_INBOX: undefined,
  })
)

describe("PX-03: room mentions", () => {
  it("reach the person mentioned, and only them", async () => {
    const r = await room()
    as(r.asha)
    await postMessage({
      roomId: r.roomId,
      body: "@Ravi can you check?",
      people: [r.ravi],
    })
    expect(await eventsFor(r.ravi)).toEqual([
      {
        type: "room-mention",
        threadId: r.roomId,
        href: `/rooms/${r.roomId}`,
        name: "Asha",
        glyph: `room-${r.roomId}`,
        room: "Launch",
        preview: "@Ravi can you check?",
      },
    ])
    expect(await eventsFor(r.asha)).toEqual([])
  })

  it("people mentions are stored only for active members other than the writer", async () => {
    const r = await room()
    const outsider = await newUser()
    as(r.asha)
    await postMessage({
      roomId: r.roomId,
      body: "hi all",
      people: [r.ravi, outsider, r.asha],
    })
    const { rows } = await pg.query<{ parts: unknown }>(
      "select parts from kriya.room_messages where room_id = $1 and author_kind = 'human'",
      [r.roomId]
    )
    expect(rows[0].parts).toEqual({ mentions: [{ kind: "person", id: r.ravi }] })
  })

  it("nothing with rooms.enabled off", async () => {
    const r = await room()
    as(r.asha)
    await postMessage({ roomId: r.roomId, body: "@Ravi hi", people: [r.ravi] })
    roomsEnv({ KRIYA_ROOMS_ENABLED: "off" })
    expect(await eventsFor(r.ravi)).toEqual([])
  })
})

describe("PX-03: replies waiting for Share in room", () => {
  it("reach the agent's owner with rooms.agents on, and nobody else", async () => {
    const r = await room()
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('ev-lekha', $1, 'Lekha', 'r', 'g')",
      [r.asha]
    )
    await pg.query(
      "insert into kriya.room_disclosures (room_id, owner_id, agent_id, body) values ($1, $2, 'ev-lekha', 'held')",
      [r.roomId, r.asha]
    )
    expect(await eventsFor(r.asha)).toEqual([])
    roomsEnv({
      KRIYA_ROOMS_ENABLED: "on",
      KRIYA_ROOMS_AGENTS: "on",
      KRIYA_AGENTS_INBOX: "on",
    })
    const events = await eventsFor(r.asha)
    expect(events).toEqual([
      expect.objectContaining({
        type: "room-disclosure",
        href: "/inbox",
        name: "Lekha",
        room: "Launch",
      }),
    ])
    expect(JSON.stringify(events)).not.toContain("held")
    expect(await eventsFor(r.ravi)).toEqual([])
  })
})
