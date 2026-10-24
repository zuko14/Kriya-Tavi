import { describe, expect, it } from "vitest"

import { readJson } from "@/lib/json-body"

const post = (body: BodyInit) =>
  new Request("https://kriya.test/x", { method: "POST", body, duplex: "half" } as never)

// A body with no Content-Length, sent in pieces, like a chunked upload
const chunked = (pieces: string[]) =>
  post(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
        controller.close()
      },
    })
  )

describe("readJson", () => {
  it("reads a body within the cap", async () => {
    expect(await readJson(post('{"a":1}'), 100)).toEqual({ ok: true, body: { a: 1 } })
    expect(await readJson(chunked(['{"a"', ":2}"]), 100)).toEqual({
      ok: true,
      body: { a: 2 },
    })
  })

  it("stops a chunked body at the cap", async () => {
    const result = await readJson(chunked(["x".repeat(60), "x".repeat(60)]), 100)
    expect(result).toEqual({ ok: false, tooLarge: true })
  })

  it("answers malformed JSON and a missing body as not ok, not too large", async () => {
    expect(await readJson(post("{nope"), 100)).toEqual({ ok: false, tooLarge: false })
    expect(
      await readJson(new Request("https://kriya.test/x", { method: "GET" }), 100)
    ).toEqual({ ok: false, tooLarge: false })
  })
})
