import fs from "node:fs"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { roomsDb, roomsEnv } from "./setup"

// REALTIME §5: RT-RLT-01 (a content-free ping after every committed message,
// whose failure never fails the action), RT-RLT-02 (catch-up by seq is
// idempotent and fetches gaps) and RT-RLT-04 (polling every 10 s, with
// rooms.realtime off or the channel down). RT-RLT-03 is the staging check.

vi.mock("server-only", () => ({}))
const session = vi.hoisted(() => ({ user: "", ip: "10.0.0.1" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: session.user, email: null }),
  authenticate: async () => (session.user ? { id: session.user, email: null } : null),
  appUrl: () => "https://kriya.test",
}))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": session.ip }),
}))
const logged = vi.hoisted(() => [] as string[])
vi.mock("@/lib/log", () => {
  const record = (level: string) => (message: string, data?: unknown) =>
    void logged.push(`${level} ${message} ${JSON.stringify(data ?? {})}`)
  return {
    log: { info: record("info"), warn: record("warn"), error: record("error") },
  }
})
// The person's own session, as lib/supabase reads it from their cookies
vi.mock("@/lib/supabase", () => ({
  createSupabase: async () => ({
    auth: {
      getSession: async () => ({
        data: {
          session: session.user
            ? { access_token: `token-of-${session.user}`, expires_at: 1_900_000_000 }
            : null,
        },
      }),
    },
  }),
}))

import { createRoom, postMessage } from "@/actions/rooms"
import { GET } from "@/app/api/rooms/[roomId]/messages/route"
import { GET as realtimeToken } from "@/app/api/rooms/realtime/route"
import { mergeMessages, POLL_MS } from "@/components/rooms/merge"

let newUser: () => Promise<string>
const SUPABASE = "http://127.0.0.1:54321"
const sent: { url: string; init: RequestInit }[] = []
let reply: () => Promise<Response>

beforeAll(async () => {
  ;({ createUser: newUser } = await roomsDb())
})
beforeEach(() => {
  roomsEnv({
    KRIYA_ROOMS_REALTIME: "on",
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
    SUPABASE_SECRET_KEY: "sb_secret_test",
  })
  sent.length = 0
  logged.length = 0
  reply = async () => new Response(null, { status: 202 })
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init })
    return reply()
  })
})
afterEach(() => vi.unstubAllGlobals())

async function room() {
  session.user = await newUser()
  const made = await createRoom({ title: "Realtime" })
  if (!("ok" in made)) throw new Error(made.error)
  return made.roomId
}

const get = (roomId: string, after?: number) =>
  GET(
    new Request(
      `https://kriya.test/api/rooms/${roomId}/messages${after === undefined ? "" : `?after=${after}`}`
    ),
    { params: Promise.resolve({ roomId }) }
  )

describe("RT-RLT-01: the server ping", () => {
  it("each committed message sends one private ping carrying only its seq", async () => {
    const roomId = await room()
    await postMessage({ roomId, body: "secret plans" })
    await postMessage({ roomId, body: "more" })
    expect(sent.map((s) => s.url)).toEqual([
      `${SUPABASE}/realtime/v1/api/broadcast/${encodeURIComponent(`room:${roomId}`)}/events/seq?private=true`,
      `${SUPABASE}/realtime/v1/api/broadcast/${encodeURIComponent(`room:${roomId}`)}/events/seq?private=true`,
    ])
    expect(sent.map((s) => JSON.parse(String(s.init.body)))).toEqual([
      { seq: 1 },
      { seq: 2 },
    ])
    expect(sent[0].init.method).toBe("POST")
    expect((sent[0].init.headers as Record<string, string>).apikey).toBe("sb_secret_test")
    expect(JSON.stringify(sent)).not.toContain("secret plans")
  })

  it("a failed ping is logged and never fails the message", async () => {
    const roomId = await room()
    reply = async () => new Response("nope", { status: 500 })
    expect(await postMessage({ roomId, body: "one" })).toMatchObject({ ok: true, seq: 1 })
    reply = async () => {
      throw new Error("network down")
    }
    expect(await postMessage({ roomId, body: "two" })).toMatchObject({ ok: true, seq: 2 })
    expect(
      logged.filter((line) => line.startsWith("warn rooms: realtime ping failed"))
    ).toHaveLength(2)
    expect(logged.join("\n")).not.toContain("sb_secret_test")
  })

  it("with rooms.realtime off no ping is sent", async () => {
    roomsEnv({ KRIYA_ROOMS_REALTIME: "off" })
    const roomId = await room()
    await postMessage({ roomId, body: "quiet" })
    expect(sent).toEqual([])
  })
})

describe("RT-RLT-02: catch-up by seq", () => {
  it("the route returns only messages after the cursor; asking twice is the same", async () => {
    roomsEnv({ KRIYA_ROOMS_REALTIME: "off" })
    const roomId = await room()
    for (const body of ["a", "b", "c"]) await postMessage({ roomId, body })
    const all = await (await get(roomId)).json()
    expect(all.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3])
    const after1 = await (await get(roomId, 1)).json()
    const again = await (await get(roomId, 1)).json()
    expect(after1.messages.map((m: { body: string }) => m.body)).toEqual(["b", "c"])
    expect(again).toEqual(after1)
    expect((await get(roomId, 3)).status).toBe(200)
    expect((await (await get(roomId, 3)).json()).messages).toEqual([])
  })

  it("merging is idempotent, ordered by seq, fills gaps and takes newer copies", () => {
    const m = (seq: number, body: string | null = `m${seq}`) => ({
      id: `id${seq}`,
      seq,
      body,
    })
    const have = [m(1), m(2), m(4)]
    expect(mergeMessages(have, [m(3), m(4), m(5)]).map((x) => x.seq)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(mergeMessages(have, have)).toEqual(have)
    // A message deleted since: the newer copy wins
    expect(mergeMessages(have, [m(2, null)]).find((x) => x.seq === 2)?.body).toBeNull()
    expect(mergeMessages([], [])).toEqual([])
  })

  it("the route refuses strangers, signed-out requests and bad input", async () => {
    const roomId = await room()
    session.user = await newUser()
    expect((await (await get(roomId)).json()).messages).toEqual([])
    session.user = ""
    expect((await get(roomId)).status).toBe(401)
    session.user = await newUser()
    expect((await get("not-a-room")).status).toBe(404)
    expect((await get(roomId, -1)).status).toBe(400)
  })
})

describe("RF-06: the browser's Realtime join", () => {
  it("hands the signed-in page only its own session token, with rooms.realtime on", async () => {
    session.user = await newUser()
    const res = await realtimeToken()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({
      token: `token-of-${session.user}`,
      expiresAt: 1_900_000_000,
    })
  })

  it("is gone with rooms.realtime or rooms.enabled off, and refuses signed-out requests", async () => {
    session.user = await newUser()
    roomsEnv({ KRIYA_ROOMS_REALTIME: "off" })
    expect((await realtimeToken()).status).toBe(404)
    roomsEnv({ KRIYA_ROOMS_REALTIME: "on", KRIYA_ROOMS_ENABLED: "off" })
    expect((await realtimeToken()).status).toBe(404)
    roomsEnv({ KRIYA_ROOMS_REALTIME: "on" })
    session.user = ""
    expect((await realtimeToken()).status).toBe(401)
  })

  it("the room view subscribes to its private channel only with rooms.realtime on, and polls while not subscribed", () => {
    const view = fs.readFileSync("components/rooms/room-view.tsx", "utf8")
    expect(view).toMatch(
      /channel\(`room:\$\{room\.id\}`, \{ config: \{ private: true \} \}\)/
    )
    expect(view).toMatch(/"broadcast", \{ event: "seq" \}/)
    expect(view).toMatch(/if \(!realtime\) return/)
    expect(view).toMatch(/if \(live\) return/)
  })
})

describe("RT-RLT-04: polling", () => {
  it("the room view polls every 10 s, on focus, and after the person's own post", () => {
    expect(POLL_MS).toBe(10_000)
    const view = fs.readFileSync("components/rooms/room-view.tsx", "utf8")
    expect(view).toMatch(/setInterval\([^)]*POLL_MS\)/)
    expect(view).toMatch(/visibilitychange|"focus"/)
    expect(view).toMatch(/\/api\/rooms\/\$\{room\.id\}\/messages\?after=/)
  })

  it("the route works with rooms.realtime off and is gone with rooms.enabled off", async () => {
    roomsEnv({ KRIYA_ROOMS_REALTIME: "off" })
    const roomId = await room()
    await postMessage({ roomId, body: "polled" })
    expect((await (await get(roomId, 0)).json()).messages).toHaveLength(1)
    roomsEnv({ KRIYA_ROOMS_ENABLED: "off" })
    expect((await get(roomId, 0)).status).toBe(404)
  })
})
