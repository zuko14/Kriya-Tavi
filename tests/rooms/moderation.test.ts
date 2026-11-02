import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { asUser, type TestDb } from "../db/harness"
import { roomsDb, roomsEnv, tokenOf } from "./setup"

// RT-MOD (RD-18): removing a member (RT-MOD-01) and the rate limits on
// invites (20 a day per person) and joins (10 an hour per address), from R2;
// blocking (RT-MOD-02) and reporting to the owner console (RT-MOD-03), from
// R9 with migration 20270401000200. A blocked member's mention is in
// invoke.test.ts, with the agent set-up.

vi.mock("server-only", () => ({}))
const session = vi.hoisted(() => ({ user: "", ip: "10.0.0.1", owner: false }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: session.user, email: null }),
  // notFound() for anyone but the Kriya owner, as lib/auth does
  requireOwner: async () => {
    if (!session.owner) throw new Error("NEXT_NOT_FOUND")
    return { id: session.user, email: null }
  },
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": session.ip }),
}))

import {
  blockPerson,
  createInvite,
  createRoom,
  joinRoom,
  postMessage,
  removeMember,
  reportRoom,
  reviewRoomReport,
  unblockPerson,
} from "@/actions/rooms"
import { blockedPeople, getRoom, readMessages, roomsOverview } from "@/queries/rooms"

let pg: TestDb
let newUser: () => Promise<string>
let ipCount = 0
const as = (user: string, ip?: string) => {
  session.user = user
  session.owner = false
  session.ip = ip ?? `10.2.${Math.floor(++ipCount / 250)}.${ipCount % 250}`
}

async function roomWith(count: number) {
  const owner = await newUser()
  as(owner)
  const made = await createRoom({ title: "Society committee" })
  if (!("ok" in made)) throw new Error(made.error)
  const invite = await createInvite({ roomId: made.roomId, maxUses: 25 })
  if (!("ok" in invite)) throw new Error(invite.error)
  const others: string[] = []
  for (let i = 0; i < count; i++) {
    const user = await newUser()
    as(user)
    await joinRoom(tokenOf(invite.url))
    others.push(user)
  }
  return { owner, roomId: made.roomId, invite, others }
}

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await roomsDb())
})
beforeEach(() => roomsEnv())

describe("RT-MOD-01: removing a member", () => {
  it("the owner removes a member, who loses access at once and can't rejoin", async () => {
    const { owner, roomId, invite, others } = await roomWith(1)
    const [bob] = others
    as(bob)
    await postMessage({ roomId, body: "before" })
    as(owner)
    expect(await removeMember({ roomId, userId: bob })).toEqual({ ok: true })
    const { rows } = await pg.query<{ removed_by: string; left_at: Date | null }>(
      "select removed_by, left_at from kriya.room_members where room_id = $1 and user_id = $2",
      [roomId, bob]
    )
    expect(rows[0].removed_by).toBe(owner)
    expect(rows[0].left_at).not.toBeNull()

    as(bob)
    expect(await getRoom(bob, roomId)).toBeNull()
    expect(await readMessages(bob, roomId)).toEqual([])
    expect(await postMessage({ roomId, body: "after" })).toEqual({
      error: "Room not found.",
    })
    expect(await joinRoom(tokenOf(invite.url))).toEqual({
      error: "You were removed from this room.",
    })
  })

  it("an admin removes members; a plain member removes nobody; nobody removes the owner", async () => {
    const { owner, roomId, others } = await roomWith(3)
    const [admin, bob, carol] = others
    // The owner makes them an admin (no action for that until R3), as rooms-rls does
    await asUser(pg, owner, (tx) =>
      tx.query(
        "update kriya.room_members set role = 'admin' where room_id = $1 and user_id = $2",
        [roomId, admin]
      )
    )
    as(bob)
    expect(await removeMember({ roomId, userId: carol })).toEqual({
      error: "Member not found.",
    })
    expect(await removeMember({ roomId, userId: owner })).toEqual({
      error: expect.stringMatching(/owner/),
    })
    as(admin)
    expect(await removeMember({ roomId, userId: owner })).toEqual({
      error: expect.stringMatching(/owner/),
    })
    expect(await removeMember({ roomId, userId: carol })).toEqual({ ok: true })
    // Removing oneself is leaving, not removal
    expect(await removeMember({ roomId, userId: admin })).toEqual({
      error: "Member not found.",
    })
    expect(await removeMember({ roomId, userId: "not-a-uuid" })).toEqual({
      error: expect.any(String),
    })
    expect((await getRoom(owner, roomId))?.members.map((m) => m.userId).sort()).toEqual(
      [owner, admin, bob].sort()
    )
  })
})

describe("RT-MOD: rate limits", () => {
  it("20 invites a day per person", async () => {
    const owner = await newUser()
    as(owner)
    const made = await createRoom({ title: "Invites" })
    const roomId = (made as { roomId: string }).roomId
    for (let i = 0; i < 20; i++) {
      expect(await createInvite({ roomId }), `invite ${i}`).toMatchObject({ ok: true })
    }
    expect(await createInvite({ roomId })).toEqual({
      error: expect.stringMatching(/Too many/),
    })
  })

  it("10 joins an hour per address, refused before the invite is touched", async () => {
    const { owner, roomId } = await roomWith(0)
    as(owner)
    const invite = await createInvite({ roomId, maxUses: 25 })
    if (!("ok" in invite)) throw new Error(invite.error)
    for (let i = 0; i < 10; i++) {
      as(await newUser(), "10.9.9.9")
      expect(await joinRoom(tokenOf(invite.url)), `join ${i}`).toMatchObject({ ok: true })
    }
    as(await newUser(), "10.9.9.9")
    expect(await joinRoom(tokenOf(invite.url))).toEqual({
      error: expect.stringMatching(/Too many/),
    })
    const { rows } = await pg.query<{ uses: number }>(
      "select uses from kriya.room_invites where id = $1",
      [invite.inviteId]
    )
    expect(rows[0].uses).toBe(10)
  })
})

describe("RT-MOD-02: blocking", () => {
  it("blocks only someone you share a room with, never yourself; unblocks", async () => {
    const { owner, roomId, others } = await roomWith(1)
    const [bob] = others
    const stranger = await newUser()
    as(owner)
    expect(await blockPerson({ userId: owner })).toEqual({
      error: "You can't block yourself.",
    })
    expect(await blockPerson({ userId: stranger })).toEqual({
      error: "Member not found.",
    })
    expect(await blockPerson({ userId: bob })).toEqual({ ok: true })
    // Twice is the same block
    expect(await blockPerson({ userId: bob })).toEqual({ ok: true })
    expect((await blockedPeople(owner)).map((b) => b.userId)).toEqual([bob])
    expect((await getRoom(owner, roomId))?.blocked).toEqual([bob])
    // Bob can't see it
    expect(await blockedPeople(bob)).toEqual([])
    expect((await getRoom(bob, roomId))?.blocked).toEqual([])
    expect(await unblockPerson({ userId: bob })).toEqual({ ok: true })
    expect(await unblockPerson({ userId: bob })).toEqual({ error: "Not blocked." })
    expect(await blockedPeople(owner)).toEqual([])
  })

  it("blocked people can't invite you; others' invites and members are untouched", async () => {
    const { owner: asha, roomId, others } = await roomWith(1)
    const [bob] = others
    // Bob has a room of his own with an invite; so does Carol
    as(bob)
    const bobs = await createRoom({ title: "Bob's room" })
    const bobsId = (bobs as { roomId: string }).roomId
    const bobInvite = await createInvite({ roomId: bobsId })
    const carol = await newUser()
    as(carol)
    const carols = await createRoom({ title: "Carol's" })
    const carolInvite = await createInvite({
      roomId: (carols as { roomId: string }).roomId,
    })
    as(asha)
    const ashaInvite = await createInvite({ roomId })
    if (!("ok" in bobInvite) || !("ok" in carolInvite) || !("ok" in ashaInvite))
      throw new Error("invite")
    await blockPerson({ userId: bob })

    // Asha blocked Bob: his invite doesn't let her in, and isn't used up
    expect(await joinRoom(tokenOf(bobInvite.url))).toEqual({
      error: expect.stringMatching(/You blocked the person who made this invite/),
    })
    const { rows } = await pg.query<{ uses: number }>(
      "select uses from kriya.room_invites where room_id = $1",
      [bobsId]
    )
    expect(rows[0].uses).toBe(0)
    // Bob, still a member of Asha's room, opening her link changes nothing
    as(bob)
    expect(await joinRoom(tokenOf(ashaInvite.url))).toEqual({ ok: true, roomId })
    // A third person's invite is untouched by the block
    expect(await joinRoom(tokenOf(carolInvite.url))).toMatchObject({ ok: true })

    as(asha)
    await unblockPerson({ userId: bob })
    expect(await joinRoom(tokenOf(bobInvite.url))).toEqual({ ok: true, roomId: bobsId })
  })

  it("someone the invite's maker blocked gets the plain invalid-invite answer", async () => {
    const asha = await newUser()
    const bob = await newUser()
    as(asha)
    const made = await createRoom({ title: "Shared first" })
    const roomId = (made as { roomId: string }).roomId
    const first = await createInvite({ roomId })
    if (!("ok" in first)) throw new Error(first.error)
    as(bob)
    await joinRoom(tokenOf(first.url))
    as(asha)
    await blockPerson({ userId: bob })
    await removeMember({ roomId, userId: bob })
    // A new room of Asha's, a fresh invite: Bob is refused without the reason
    const other = await createRoom({ title: "Asha's next" })
    const next = await createInvite({ roomId: (other as { roomId: string }).roomId })
    if (!("ok" in next)) throw new Error(next.error)
    as(bob)
    expect(await joinRoom(tokenOf(next.url))).toEqual({
      error: "This invite link isn't valid any more. Ask for a new one.",
    })
  })
})

describe("RT-MOD-03: reporting", () => {
  it("a member reports a message once; the owner console sees the copy", async () => {
    const { owner, roomId, others } = await roomWith(1)
    const [bob] = others
    as(bob)
    const posted = await postMessage({ roomId, body: "cheap loans, call now" })
    if (!("ok" in posted)) throw new Error(posted.error)
    as(owner)
    expect(
      await reportRoom({
        roomId,
        messageId: posted.messageId,
        reason: "spam",
        note: "ads",
      })
    ).toEqual({ ok: true })
    expect(
      await reportRoom({ roomId, messageId: posted.messageId, reason: "spam" })
    ).toEqual({ error: expect.stringMatching(/already reported/) })
    // Bob deletes it afterwards; the copy stays for the owner console
    as(bob)
    await pg.query("update kriya.room_messages set deleted_at = now() where id = $1", [
      posted.messageId,
    ])
    const overview = await roomsOverview()
    const report = overview.reports.find((r) => r.messageId === posted.messageId)
    expect(report).toMatchObject({
      reporterId: owner,
      authorId: bob,
      authorKind: "human",
      body: "cheap loans, call now",
      reason: "spam",
      note: "ads",
      status: "open",
    })
    expect(overview.openReports).toBeGreaterThanOrEqual(1)
  })

  it("refuses non-members, other rooms' messages, bad reasons and too many", async () => {
    const { owner, roomId, others } = await roomWith(1)
    const [bob] = others
    const outsider = await newUser()
    as(outsider)
    expect(await reportRoom({ roomId, reason: "spam" })).toEqual({
      error: "Room not found.",
    })
    as(owner)
    const other = await createRoom({ title: "Elsewhere" })
    const otherId = (other as { roomId: string }).roomId
    const elsewhere = await postMessage({ roomId: otherId, body: "mine" })
    if (!("ok" in elsewhere)) throw new Error(elsewhere.error)
    as(bob)
    expect(
      await reportRoom({ roomId, messageId: elsewhere.messageId, reason: "spam" })
    ).toEqual({ error: "Message not found." })
    expect(await reportRoom({ roomId, reason: "made-up" })).toEqual({
      error: "That request wasn't valid.",
    })
    expect(await reportRoom({ roomId, reason: "other", note: "x".repeat(501) })).toEqual({
      error: "That request wasn't valid.",
    })
    // 10 a day per person (the refused message above counted): the room
    // once, then eight of Bob's own messages
    expect(await reportRoom({ roomId, reason: "harassment" })).toEqual({ ok: true })
    for (let i = 0; i < 8; i++) {
      const m = await postMessage({ roomId, body: `m${i}` })
      if (!("ok" in m)) throw new Error(m.error)
      expect(
        await reportRoom({ roomId, messageId: m.messageId, reason: "other" })
      ).toEqual({
        ok: true,
      })
    }
    expect(await reportRoom({ roomId, reason: "other" })).toEqual({
      error: expect.stringMatching(/Too many/),
    })
  })

  it("only the Kriya owner reviews; archiving stops the room and is audited", async () => {
    const { owner, roomId, others } = await roomWith(1)
    const [bob] = others
    as(bob)
    expect(await reportRoom({ roomId, reason: "unsafe" })).toEqual({ ok: true })
    const [{ id: reportId }] = (
      await pg.query<{ id: string }>(
        "select id from kriya.room_reports where room_id = $1 and reporter_id = $2",
        [roomId, bob]
      )
    ).rows
    // A room's own owner isn't the Kriya owner
    as(owner)
    await expect(reviewRoomReport({ reportId, outcome: "dismissed" })).rejects.toThrow(
      /NOT_FOUND/
    )
    const kriyaOwner = await newUser()
    as(kriyaOwner)
    session.owner = true
    expect(await reviewRoomReport({ reportId, outcome: "archive" })).toEqual({ ok: true })
    expect(await reviewRoomReport({ reportId, outcome: "dismissed" })).toEqual({
      error: "That report isn't open any more.",
    })
    const { rows } = await pg.query<{ status: string; reviewed_by: string }>(
      `select r.status, p.reviewed_by from kriya.rooms r
         join kriya.room_reports p on p.room_id = r.id where p.id = $1`,
      [reportId]
    )
    expect(rows[0]).toEqual({ status: "archived", reviewed_by: kriyaOwner })
    const { rows: audits } = await pg.query<{ action: string }>(
      "select action from kriya.audit_events where target_id = $1",
      [reportId]
    )
    expect(audits).toEqual([{ action: "room_report.archive" }])
    as(bob)
    expect(await postMessage({ roomId, body: "still here?" })).toEqual({
      error: "This room is archived.",
    })
    const { rows: lines } = await pg.query<{ body: string }>(
      "select body from kriya.room_messages where room_id = $1 and author_kind = 'system'",
      [roomId]
    )
    expect(lines.map((l) => l.body)).toContain("Kriya archived this room after a report.")
  })
})
