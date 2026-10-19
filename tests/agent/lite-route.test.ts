import { describe, expect, it, vi } from "vitest"

// AT-LITE-01: the turn route asks streamTask for the slower Lite stream
// when the browser says so (x-kriya-lite: 1 or ?lite=1), and only then.
// Session and queue are stubbed: this checks the route's one decision.

const { streamTask } = vi.hoisted(() => ({
  streamTask: vi.fn(
    () =>
      new ReadableStream({
        start: (controller) => controller.close(),
      })
  ),
}))

vi.mock("@/lib/auth", () => ({ authenticate: async () => ({ id: "u1", email: null }) }))
vi.mock("@/lib/rate-limit", () => ({ allow: async () => true }))
vi.mock("@/lib/agent/queue", () => ({
  activeTask: async () => ({ id: "task1" }),
  enqueueTurn: async () => ({ id: "task2" }),
  cancelThreadTask: async () => true,
  streamTask,
  TurnError: class extends Error {},
}))

import { GET } from "@/app/api/threads/[threadId]/turn/route"

const reattach = (url: string, headers: Record<string, string> = {}) =>
  GET(new Request(url, { headers }), { params: Promise.resolve({ threadId: "t1" }) })

describe("turn route (AT-LITE-01)", () => {
  it("passes Lite mode through from the header or the query", async () => {
    await reattach("https://kriya.test/api/threads/t1/turn", { "x-kriya-lite": "1" })
    expect(streamTask).toHaveBeenLastCalledWith("u1", "task1", expect.anything(), {
      lite: true,
    })
    await reattach("https://kriya.test/api/threads/t1/turn?lite=1")
    expect(streamTask).toHaveBeenLastCalledWith("u1", "task1", expect.anything(), {
      lite: true,
    })
  })

  it("streams normally otherwise", async () => {
    await reattach("https://kriya.test/api/threads/t1/turn", { "x-kriya-lite": "0" })
    expect(streamTask).toHaveBeenLastCalledWith("u1", "task1", expect.anything(), {
      lite: false,
    })
  })
})
