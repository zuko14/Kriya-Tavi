import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { TestDb } from "../db/harness"
import { roomsDb, roomsEnv, tokenOf } from "./setup"

// R3 (UX_SPEC §1, §2, §4): RT-UI-01, the Rooms entries exist only with
// rooms.enabled on (roomsEntry, the palette's and sidebar's source), the
// room list's markup and unread counts, member names (RF-08), deleting
// one's own message and archiving. Sizes, themes and two-account flows are
// the browser check's.

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
  archiveRoom,
  createInvite,
  createRoom,
  deleteMessage,
  joinRoom,
  markRead,
  postMessage,
  roomsEntry,
  setMemberRole,
} from "@/actions/rooms"
import { RoomList } from "@/components/rooms/room-list"
import { getRoom, listRooms, readMessages } from "@/queries/rooms"

let pg: TestDb
let newUser: () => Promise<string>
let ip = 0
const as = (user: string) => {
  session.user = user
  session.ip = `10.3.0.${++ip % 250}`
}

async function pair() {
  const alice = await newUser()
  const bob = await newUser()
  await pg.query("update kriya.profiles set display_name = 'Alice Rao' where id = $1", [
    alice,
  ])
  as(alice)
  const made = await createRoom({ title: "Launch" })
  const roomId = (made as { roomId: string }).roomId
  const invite = await createInvite({ roomId })
  as(bob)
  await joinRoom(tokenOf((invite as { url: string }).url))
  return { alice, bob, roomId }
}

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await roomsDb())
})
beforeEach(() => roomsEnv())

describe("RT-UI-01: Rooms entries only with rooms.enabled on", () => {
  it("roomsEntry is null when off and counts unread messages when on", async () => {
    const { alice, bob, roomId } = await pair()
    as(alice)
    await postMessage({ roomId, body: "one" })
    await postMessage({ roomId, body: "two" })
    // Your own messages are read
    expect(await roomsEntry()).toEqual({ unread: 0 })
    as(bob)
    expect(await roomsEntry()).toEqual({ unread: 2 })
    await markRead({ roomId, seq: 1 })
    expect(await roomsEntry()).toEqual({ unread: 1 })
    roomsEnv({ KRIYA_ROOMS_ENABLED: "off" })
    expect(await roomsEntry()).toBeNull()
  })

  it("the room list shows unread counts, archived rooms and the empty state", () => {
    const html = renderToStaticMarkup(
      createElement(RoomList, {
        rooms: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            title: "Launch",
            status: "active",
            role: "owner",
            lastSeq: 5,
            lastReadSeq: 2,
            updatedAt: new Date(),
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            title: "Old trip",
            status: "archived",
            role: "member",
            lastSeq: 1,
            lastReadSeq: 1,
            updatedAt: new Date(),
          },
        ],
      })
    )
    expect(html).toContain('href="/rooms/00000000-0000-4000-8000-000000000001"')
    expect(html).toContain("3 new")
    expect(html).toContain("Archived")
    expect(renderToStaticMarkup(createElement(RoomList, { rooms: [] }))).toContain(
      "Rooms are for working with people and their agents."
    )
  })
})

describe("room page data", () => {
  it("members see each other's display names only; others get nothing (RF-08)", async () => {
    const { alice, bob, roomId } = await pair()
    const room = await getRoom(bob, roomId)
    expect(room?.members.find((m) => m.userId === alice)?.name).toBe("Alice Rao")
    expect(room?.members.find((m) => m.userId === bob)?.name).toBe("Member")
    expect(Object.keys(room!.members[0]).sort()).toEqual([
      "joinedAt",
      "name",
      "role",
      "userId",
    ])
    expect(await getRoom(await newUser(), roomId)).toBeNull()
  })

  it("a person deletes only their own message; its text is gone for everyone", async () => {
    const { alice, bob, roomId } = await pair()
    as(alice)
    const mine = await postMessage({ roomId, body: "oops" })
    const id = (mine as { messageId: string }).messageId
    as(bob)
    expect(await deleteMessage({ roomId, messageId: id })).toEqual({
      error: "Message not found.",
    })
    as(alice)
    expect(await deleteMessage({ roomId, messageId: id })).toEqual({ ok: true })
    const [message] = await readMessages(bob, roomId)
    expect(message.body).toBeNull()
    expect(message.deletedAt).not.toBeNull()
  })

  it("only the owner or an admin archives; an archived room takes no messages", async () => {
    const { alice, bob, roomId } = await pair()
    as(bob)
    expect(await archiveRoom(roomId)).toEqual({ error: "Room not found." })
    as(alice)
    expect(await archiveRoom(roomId)).toEqual({ ok: true })
    expect((await listRooms(alice))[0].status).toBe("archived")
    expect(await postMessage({ roomId, body: "late" })).toEqual({
      error: "This room is archived.",
    })
  })

  it("the owner makes a member an admin and back; members and the owner's role can't be changed", async () => {
    const { alice, bob, roomId } = await pair()
    const carol = await newUser()
    as(alice)
    const invite = await createInvite({ roomId })
    as(carol)
    await joinRoom(tokenOf((invite as { url: string }).url))
    const roleOf = async (user: string) =>
      (await getRoom(alice, roomId))?.members.find((m) => m.userId === user)?.role

    // A plain member changes nobody's role, nor their own
    as(bob)
    expect(await setMemberRole({ roomId, userId: carol, role: "admin" })).toEqual({
      error: "Member not found.",
    })
    expect(await setMemberRole({ roomId, userId: bob, role: "admin" })).toEqual({
      error: "Member not found.",
    })
    as(alice)
    expect(await setMemberRole({ roomId, userId: bob, role: "admin" })).toEqual({
      ok: true,
    })
    expect(await roleOf(bob)).toBe("admin")
    // An admin can now invite and remove; nobody makes an owner or changes the owner
    as(bob)
    expect(await createInvite({ roomId })).toMatchObject({ ok: true })
    expect(await setMemberRole({ roomId, userId: alice, role: "member" })).toEqual({
      error: "The room's owner keeps their role.",
    })
    expect(
      await setMemberRole({ roomId, userId: carol, role: "owner" } as never)
    ).toEqual({
      error: "That request wasn't valid.",
    })
    as(alice)
    expect(await setMemberRole({ roomId, userId: bob, role: "member" })).toEqual({
      ok: true,
    })
    expect(await roleOf(bob)).toBe("member")
    roomsEnv({ KRIYA_ROOMS_ENABLED: "off" })
    expect(await setMemberRole({ roomId, userId: bob, role: "admin" })).toEqual({
      error: "Room not found.",
    })
  })
})
