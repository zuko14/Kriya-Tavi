import { createHash } from "node:crypto"
import fs from "node:fs"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { TestDb } from "../db/harness"
import { roomsDb, roomsEnv, tokenOf } from "./setup"

// RT-ACT-01 (actions validate with zod, act through withUser, are rate
// limited) and RT-ACT-02 (invites by admins only, joining through a token,
// capacity), plus the R2 part of RT-REG-01: with rooms.enabled off every
// room action and query refuses before touching a room table.

vi.mock("server-only", () => ({}))
const session = vi.hoisted(() => ({ user: "", ip: "10.0.0.1" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: session.user, email: null }),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": session.ip }),
}))

import {
  createInvite,
  createRoom,
  joinRoom,
  leaveRoom,
  markRead,
  postMessage,
  revokeInvite,
} from "@/actions/rooms"
import { getRoom, listInvites, listRooms, readMessages } from "@/queries/rooms"

let pg: TestDb
let newUser: () => Promise<string>
let ipCount = 0
const as = (user: string) => {
  session.user = user
  // A fresh address each time, so the join limit is tested only where meant
  session.ip = `10.1.${Math.floor(++ipCount / 250)}.${ipCount % 250}`
}
const sha = (token: string) => createHash("sha256").update(token).digest("hex")

async function roomOf(owner: string, title = "Trip planning") {
  as(owner)
  const made = await createRoom({ title })
  if (!("ok" in made)) throw new Error(made.error)
  return made.roomId
}

async function inviteTo(admin: string, roomId: string, maxUses?: number) {
  as(admin)
  const invite = await createInvite({ roomId, maxUses })
  if (!("ok" in invite)) throw new Error(invite.error)
  return invite
}

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await roomsDb())
})
beforeEach(() => roomsEnv())

describe("RT-ACT-01: room actions", () => {
  it("createRoom validates, makes the creator the owner and returns the room", async () => {
    const alice = await newUser()
    as(alice)
    expect(await createRoom({ title: "" })).toEqual({ error: expect.any(String) })
    expect(await createRoom({ title: "x".repeat(81) })).toEqual({
      error: expect.any(String),
    })
    expect(await createRoom({ title: "ok", topic: "y".repeat(501) })).toEqual({
      error: expect.any(String),
    })
    // The browser can't choose who the room belongs to
    const made = await createRoom({ title: "  Trip  ", createdBy: "someone" } as never)
    expect(made).toEqual({ ok: true, roomId: expect.any(String) })
    const roomId = (made as { roomId: string }).roomId
    const room = await getRoom(alice, roomId)
    expect(room?.room.title).toBe("Trip")
    expect(room?.room.createdBy).toBe(alice)
    expect(room?.role).toBe("owner")
    expect(room?.members.map((m) => [m.userId, m.role])).toEqual([[alice, "owner"]])
    expect((await listRooms(alice)).map((r) => r.id)).toEqual([roomId])
  })

  it("rooms per person are capped by rooms.maxPerPerson", async () => {
    roomsEnv({ KRIYA_ROOMS_MAX_PER_PERSON: "2" })
    const alice = await newUser()
    await roomOf(alice)
    await roomOf(alice)
    as(alice)
    expect(await createRoom({ title: "third" })).toEqual({
      error: expect.stringMatching(/2 rooms/),
    })
    roomsEnv({ KRIYA_ROOMS_MAX_PER_PERSON: undefined })
  })

  it("postMessage posts as the person, numbered by the database", async () => {
    const alice = await newUser()
    const bob = await newUser()
    const roomId = await roomOf(alice)
    as(alice)
    expect(await postMessage({ roomId, body: "   " })).toEqual({
      error: expect.any(String),
    })
    expect(await postMessage({ roomId, body: "x".repeat(8001) })).toEqual({
      error: expect.any(String),
    })
    expect(await postMessage({ roomId: "not-a-uuid", body: "hi" })).toEqual({
      error: expect.any(String),
    })
    const first = await postMessage({ roomId, body: "hello" })
    const second = await postMessage({ roomId, body: "again" })
    expect(first).toEqual({ ok: true, messageId: expect.any(String), seq: 1 })
    expect(second).toMatchObject({ ok: true, seq: 2 })

    // A non-member can't post or read
    as(bob)
    expect(await postMessage({ roomId, body: "let me in" })).toEqual({
      error: "Room not found.",
    })
    expect(await readMessages(bob, roomId)).toEqual([])
    expect(await getRoom(bob, roomId)).toBeNull()

    const messages = await readMessages(alice, roomId)
    expect(messages.map((m) => [m.seq, m.authorKind, m.userId, m.body])).toEqual([
      [1, "human", alice, "hello"],
      [2, "human", alice, "again"],
    ])
    expect((await readMessages(alice, roomId, { after: 1 })).map((m) => m.seq)).toEqual([
      2,
    ])
  })

  it("posting is limited to 30 messages a minute per person", async () => {
    const alice = await newUser()
    const roomId = await roomOf(alice)
    as(alice)
    for (let i = 0; i < 30; i++) {
      expect(await postMessage({ roomId, body: `m${i}` }), `message ${i}`).toMatchObject({
        ok: true,
      })
    }
    expect(await postMessage({ roomId, body: "one more" })).toEqual({
      error: expect.stringMatching(/Too many/),
    })
  })

  it("markRead moves only the person's own marker, never backwards or past the end", async () => {
    const alice = await newUser()
    const roomId = await roomOf(alice)
    as(alice)
    await postMessage({ roomId, body: "a" })
    await postMessage({ roomId, body: "b" })
    expect(await markRead({ roomId, seq: 2 })).toEqual({ ok: true })
    expect(await markRead({ roomId, seq: 1 })).toEqual({ ok: true })
    expect(await markRead({ roomId, seq: 99 })).toEqual({ ok: true })
    const { rows } = await pg.query<{ last_read_seq: string }>(
      "select last_read_seq from kriya.room_members where room_id = $1 and user_id = $2",
      [roomId, alice]
    )
    expect(Number(rows[0].last_read_seq)).toBe(2)
    expect((await listRooms(alice))[0]).toMatchObject({ lastSeq: 2, lastReadSeq: 2 })
  })

  it("every action goes through withUser, never privileged", () => {
    const source = fs.readFileSync("actions/rooms.ts", "utf8")
    expect(source).toMatch(/withUser/)
    expect(source).not.toMatch(/\bprivileged\b/)
    expect(source).toMatch(/requireUser/)
    expect(source).toMatch(/from "zod"/)
  })
})

describe("RT-ACT-02: invites and joining", () => {
  it("an owner creates an invite link; only its hash is stored", async () => {
    const alice = await newUser()
    const roomId = await roomOf(alice)
    const invite = await inviteTo(alice, roomId, 3)
    expect(invite.url).toMatch(/^https:\/\/kriya\.test\/rooms\/join\/[A-Za-z0-9_-]{43}$/)
    const token = tokenOf(invite.url)
    const { rows } = await pg.query<{ token_hash: string; max_uses: number }>(
      "select token_hash, max_uses from kriya.room_invites where id = $1",
      [invite.inviteId]
    )
    expect(rows[0]).toEqual({ token_hash: sha(token), max_uses: 3 })
    expect(JSON.stringify(rows)).not.toContain(token)
    // Expires after rooms.inviteDays (7)
    const days = (new Date(invite.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThanOrEqual(7)
    expect((await listInvites(alice, roomId)).map((i) => i.id)).toEqual([invite.inviteId])
  })

  it("invites: uses between 1 and 25; members and outsiders can't create or revoke", async () => {
    const alice = await newUser()
    const bob = await newUser()
    const carol = await newUser()
    const roomId = await roomOf(alice)
    as(alice)
    expect(await createInvite({ roomId, maxUses: 0 })).toEqual({
      error: expect.any(String),
    })
    expect(await createInvite({ roomId, maxUses: 26 })).toEqual({
      error: expect.any(String),
    })
    const invite = await inviteTo(alice, roomId)
    as(bob)
    expect(await joinRoom(tokenOf(invite.url))).toEqual({ ok: true, roomId })

    // Bob is a plain member; Carol isn't in the room
    for (const user of [bob, carol]) {
      as(user)
      expect(await createInvite({ roomId })).toEqual({ error: "Room not found." })
      expect(await revokeInvite({ roomId, inviteId: invite.inviteId })).toEqual({
        error: "Invite not found.",
      })
      expect(await listInvites(user, roomId)).toEqual([])
    }

    as(alice)
    expect(await revokeInvite({ roomId, inviteId: invite.inviteId })).toEqual({
      ok: true,
    })
    as(carol)
    expect(await joinRoom(tokenOf(invite.url))).toEqual({
      error: "This invite link isn't valid any more. Ask for a new one.",
    })
  })

  it("join: a bad token, an expired or used-up invite and a full room are refused", async () => {
    roomsEnv({ KRIYA_ROOMS_MAX_HUMANS: "3" })
    const alice = await newUser()
    const roomId = await roomOf(alice)
    as(alice)
    expect(await joinRoom("nope")).toEqual({
      error: "This invite link isn't valid any more. Ask for a new one.",
    })
    expect(await joinRoom("a".repeat(43))).toEqual({
      error: "This invite link isn't valid any more. Ask for a new one.",
    })

    const once = await inviteTo(alice, roomId, 1)
    as(await newUser())
    expect(await joinRoom(tokenOf(once.url))).toMatchObject({ ok: true })
    as(await newUser())
    expect(await joinRoom(tokenOf(once.url))).toEqual({
      error: "This invite link has been used up. Ask for a new one.",
    })

    const many = await inviteTo(alice, roomId, 10)
    as(await newUser())
    expect(await joinRoom(tokenOf(many.url))).toMatchObject({ ok: true })
    // Alice and two others: full at 3
    as(await newUser())
    expect(await joinRoom(tokenOf(many.url))).toEqual({ error: "This room is full." })

    await pg.query(
      "update kriya.room_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1",
      [many.inviteId]
    )
    as(await newUser())
    expect(await joinRoom(tokenOf(many.url))).toEqual({
      error: "This invite link isn't valid any more. Ask for a new one.",
    })
    roomsEnv({ KRIYA_ROOMS_MAX_HUMANS: undefined })
  })

  it("join: a member joining again uses nothing; one who left may come back", async () => {
    const alice = await newUser()
    const bob = await newUser()
    const roomId = await roomOf(alice)
    const invite = await inviteTo(alice, roomId, 2)
    as(bob)
    expect(await joinRoom(tokenOf(invite.url))).toEqual({ ok: true, roomId })
    expect(await joinRoom(tokenOf(invite.url))).toEqual({ ok: true, roomId })
    expect(await leaveRoom(roomId)).toEqual({ ok: true })
    expect(await getRoom(bob, roomId)).toBeNull()
    expect(await joinRoom(tokenOf(invite.url))).toEqual({ ok: true, roomId })
    expect((await getRoom(bob, roomId))?.role).toBe("member")
    const { rows } = await pg.query<{ uses: number }>(
      "select uses from kriya.room_invites where id = $1",
      [invite.inviteId]
    )
    expect(rows[0].uses).toBe(2)
  })

  it("join counts toward the joiner's rooms.maxPerPerson", async () => {
    const alice = await newUser()
    const bob = await newUser()
    const roomId = await roomOf(alice)
    const invite = await inviteTo(alice, roomId)
    roomsEnv({ KRIYA_ROOMS_MAX_PER_PERSON: "1" })
    await roomOf(bob, "Bob's own")
    as(bob)
    expect(await joinRoom(tokenOf(invite.url))).toEqual({
      error: expect.stringMatching(/1 room/),
    })
    roomsEnv({ KRIYA_ROOMS_MAX_PER_PERSON: undefined })
  })

  it("the room's owner can't leave", async () => {
    const alice = await newUser()
    const roomId = await roomOf(alice)
    as(alice)
    expect(await leaveRoom(roomId)).toEqual({ error: expect.stringMatching(/owner/) })
    expect((await getRoom(alice, roomId))?.role).toBe("owner")
  })
})

describe("RT-REG-01 (R2): rooms.enabled off", () => {
  it("every action and query refuses and no room row is written", async () => {
    const alice = await newUser()
    const roomId = await roomOf(alice)
    const invite = await inviteTo(alice, roomId)
    roomsEnv({ KRIYA_ROOMS_ENABLED: "off" })
    const before = await pg.query("select count(*)::int as n from kriya.rooms")
    as(alice)
    const off = { error: "Room not found." }
    expect(await createRoom({ title: "new" })).toEqual(off)
    expect(await createInvite({ roomId })).toEqual(off)
    expect(await revokeInvite({ roomId, inviteId: invite.inviteId })).toEqual(off)
    expect(await joinRoom(tokenOf(invite.url))).toEqual(off)
    expect(await leaveRoom(roomId)).toEqual(off)
    expect(await postMessage({ roomId, body: "hi" })).toEqual(off)
    expect(await markRead({ roomId, seq: 1 })).toEqual(off)
    expect(await listRooms(alice)).toEqual([])
    expect(await getRoom(alice, roomId)).toBeNull()
    expect(await readMessages(alice, roomId)).toEqual([])
    expect(await listInvites(alice, roomId)).toEqual([])
    const after = await pg.query("select count(*)::int as n from kriya.rooms")
    expect(after.rows).toEqual(before.rows)
  })
})
