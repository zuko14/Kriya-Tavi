import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// RT-NOTE-01…03 (R8, RD-14): an agent's note (room_note_add, R1) is saved
// unconfirmed and a member confirms it; only members' notes and confirmed
// agents' notes join the agents' room context, and nothing is copied into
// anyone's memory; the tool's class, writes and capability rows, and no
// tool writes a person-only column. A note is refused once private data is
// in the conversation, or where the owner allowed their accounts. Through
// runTask on the scripted model and PGlite; no network.

const fixtures = vi.hoisted(() => ({ user: "", ip: 0 }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: fixtures.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-forwarded-for": `10.9.0.${++fixtures.ip % 250}` }),
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
  addRoomNote,
  confirmRoomNote,
  createInvite,
  createRoom,
  deleteRoomNote,
  joinRoom,
  postMessage,
  setRoomAgentPolicy,
} from "@/actions/rooms"
import { CAPABILITIES } from "@/lib/agent/capabilities"
import { PERSON_ONLY_WRITES, TOOL_CLASSES, TOOL_WRITES } from "@/lib/agent/policy"
import { TOOL_APPROVALS } from "@/lib/agent/run-task"
import { addAgentNote } from "@/lib/rooms/notes"
import { notesFor } from "@/queries/rooms"

import { createUser } from "../db/harness"
import { reset, seen } from "../cloud/agent-mocks"
import { call, model, say, switches, world, type World } from "../operator/golden/harness"
import { roomsEnv, tokenOf } from "./setup"

let w: World
let ravi: string
let roomId: string
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
  await addRoomAgent({ roomId, agentId: "a1" })
  if (connectors)
    await setRoomAgentPolicy({
      roomId,
      agentId: "a1",
      invoke: "owner_only",
      allowConnectors: true,
    })
}

async function ask(body: string) {
  as(w.user)
  const posted = await postMessage({ roomId, body, mentions: ["a1"] })
  if (!("ok" in posted)) throw new Error(posted.error)
  return w.runQueued()
}

const notes = () =>
  w.q<{ id: string; author_kind: string; body: string; confirmed_by: string | null }>(
    "select id, author_kind, body, confirmed_by from kriya.room_notes where room_id = $1 order by created_at",
    [roomId]
  )

// The scripted agent saves a note, then says it did
const notes_ = (note: string) => (run: string, results: number) =>
  !run.includes("Request:")
    ? say("Done.")
    : results === 0
      ? call("room_note_add", { note }, "n1")
      : say("Noted for the room.")

beforeEach(async () => {
  reset()
  w = await world()
  roomsEnv({ KRIYA_ROOMS_AGENTS: "on" })
})
afterEach(() => {
  switches(false)
  roomsEnv({ KRIYA_ROOMS_ENABLED: undefined, KRIYA_ROOMS_AGENTS: undefined })
  model.script = () => say("Done.")
})

describe("RT-NOTE-01: an agent's note waits for a member", () => {
  it("is saved unconfirmed, said in the room, and a member confirms it as themselves", async () => {
    await setUp()
    model.script = notes_("The launch venue is Hall B.")
    await ask("@Lekha keep the venue in view")
    expect(await notes()).toEqual([
      {
        id: expect.any(String),
        author_kind: "agent",
        body: "The launch venue is Hall B.",
        confirmed_by: null,
      },
    ])
    const [line] = await w.q<{ body: string }>(
      "select body from kriya.room_messages where room_id = $1 and parts ->> 'kind' = 'note'",
      [roomId]
    )
    expect(line.body).toBe("Lekha added a note; a member can confirm it in Notes.")
    const [note] = await notes()
    // A non-member can't; a member can, once
    as(await createUser(w.pg))
    expect(await confirmRoomNote({ roomId, noteId: note.id })).toEqual({
      error: "Note not found.",
    })
    as(ravi)
    expect(await confirmRoomNote({ roomId, noteId: note.id })).toEqual({ ok: true })
    expect(await confirmRoomNote({ roomId, noteId: note.id })).toEqual({
      error: "Note not found.",
    })
    expect((await notes())[0].confirmed_by).toBe(ravi)
    expect((await notesFor(ravi, roomId))[0]).toMatchObject({
      agent: true,
      by: "Lekha (agent of Asha)",
      confirmedBy: "Ravi",
    })
  })

  it("people add and delete their own notes; a person's note needs no confirmation", async () => {
    await setUp()
    as(ravi)
    expect(await addRoomNote({ roomId, body: "Budget ₹2 lakh" })).toEqual({ ok: true })
    const [mine] = await notes()
    expect(mine).toMatchObject({ author_kind: "human", confirmed_by: null })
    expect(await confirmRoomNote({ roomId, noteId: mine.id })).toEqual({
      error: "Note not found.",
    })
    as(w.user)
    expect(await deleteRoomNote({ roomId, noteId: mine.id })).toEqual({
      error: "Note not found.",
    })
    as(ravi)
    expect(await deleteRoomNote({ roomId, noteId: mine.id })).toEqual({ ok: true })
    expect(await notesFor(ravi, roomId)).toEqual([])
  })

  it("is refused after a private read, and where the owner allowed their accounts", async () => {
    await setUp()
    // ledger_list reads the owner's accounts (PRIVATE_READ_TOOLS)
    model.script = (run, results) =>
      !run.includes("Request:")
        ? say("Done.")
        : results === 0
          ? call("ledger_list", { from: "2026-11-01", to: "2026-11-30" }, "l1")
          : results === 1
            ? call("room_note_add", { note: "Asha owes nothing." }, "n1")
            : say("Checked.")
    await ask("@Lekha anything due?")
    expect(await notes()).toEqual([])

    const other = await world()
    w = other
    await setUp({ connectors: true })
    model.script = notes_("Venue is Hall B.")
    await ask("@Lekha note the venue")
    expect(await notes()).toEqual([])
  })

  it("at most ten an hour per agent and room", async () => {
    await setUp()
    for (let i = 0; i < 10; i++)
      expect(
        await addAgentNote({ roomId, ownerId: w.user, agentId: "a1", body: `note ${i}` })
      ).toMatchObject({ saved: true })
    expect(
      await addAgentNote({ roomId, ownerId: w.user, agentId: "a1", body: "one more" })
    ).toEqual({
      saved: false,
      message: "You've added enough notes to this room for now.",
    })
  })
})

describe("RT-NOTE-02: only confirmed notes reach the agents; nothing goes to memory", () => {
  it("members' notes and confirmed agents' notes are in the request; unconfirmed ones aren't", async () => {
    await setUp()
    as(ravi)
    await addRoomNote({ roomId, body: "Budget ₹2 lakh" })
    await addAgentNote({
      roomId,
      ownerId: w.user,
      agentId: "a1",
      body: "Venue is Hall B",
    })
    await ask("@Lekha plan the day")
    let request = seen.tools.at(-1)!.run
    expect(request).toContain("Budget ₹2 lakh")
    expect(request).not.toContain("Venue is Hall B")

    const agentNote = (await notes()).find((n) => n.author_kind === "agent")!
    as(ravi)
    await confirmRoomNote({ roomId, noteId: agentNote.id })
    await ask("@Lekha again")
    request = seen.tools.at(-1)!.run
    expect(request).toContain("Confirmed room notes:")
    expect(request).toContain("Venue is Hall B")
    // Nothing copied into anyone's memory
    expect(
      await w.q(
        "select 1 from kriya.memories where content like '%Hall B%' or content like '%2 lakh%'"
      )
    ).toEqual([])
  })
})

describe("RT-NOTE-03: the tool's policy rows", () => {
  it("R1, writes only new notes, Kriya's own system, never waits for an approval", () => {
    expect(TOOL_CLASSES.room_note_add).toBe("R1")
    expect(TOOL_WRITES.room_note_add).toEqual(["room_notes+"])
    expect(CAPABILITIES.room_note_add).toMatchObject({
      system: "kriya",
      sideEffect: false,
      grantable: false,
    })
    expect("room_note_add" in TOOL_APPROVALS).toBe(false)
    expect(PERSON_ONLY_WRITES).toContain("room_notes.confirmed_by")
    for (const [tool, writes] of Object.entries(TOOL_WRITES))
      expect(
        writes.filter((x) => x.startsWith("room_notes.confirmed")),
        tool
      ).toEqual([])
  })

  it("is on a room task's belt only", async () => {
    await setUp()
    await ask("@Lekha hi")
    expect(seen.tools.at(-1)!.names).toContain("room_note_add")
    await w.turn("hello")
    expect(seen.tools.at(-1)!.names).not.toContain("room_note_add")
  })
})
