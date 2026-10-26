import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}))
vi.mock("@/actions/voice", () => ({
  confirmVoiceCall: async () => ({ ok: true }),
  declineVoiceCall: async () => ({ ok: true }),
}))

import { ConfirmCard } from "@/components/voice/confirm-card"
import { SETTLE_MS, watchTask } from "@/components/voice/thread-call-watch"

// D-23: the thread refreshes once when its call is over; D-19: the
// confirmation card shows the number Tavi will give, masked until shown.

const TASK = "6f1c2a9e-0b7d-4c1e-9a3f-2d5e8b7c4a10"

function fake() {
  const source = {
    url: "",
    closed: false,
    onmessage: null as ((m: { data: string }) => void) | null,
    close() {
      source.closed = true
    },
    send(event: object) {
      source.onmessage?.({ data: JSON.stringify(event) })
    },
  }
  return source
}

afterEach(() => vi.useRealTimers())

describe("watching a call from its thread", () => {
  it("refreshes once, after the task ends, and stops listening", () => {
    vi.useFakeTimers()
    const source = fake()
    const refresh = vi.fn()
    watchTask(TASK, (url) => Object.assign(source, { url }), refresh)
    expect(source.url).toBe(`/api/voice/tasks/${TASK}/stream`)
    source.send({ type: "task", status: "in_progress" })
    source.send({ type: "call", status: "in_call" })
    source.send({ type: "task", status: "awaiting_report" })
    expect(source.closed).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("a call already over when the thread opens: no refresh, the stream closes", () => {
    const source = fake()
    const refresh = vi.fn()
    watchTask(TASK, () => source, refresh)
    source.send({ type: "task", status: "completed" })
    expect(source.closed).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("leaving the thread closes the stream and cancels a pending refresh", () => {
    vi.useFakeTimers()
    const source = fake()
    const refresh = vi.fn()
    const stop = watchTask(TASK, () => source, refresh)
    source.send({ type: "task", status: "in_progress" })
    source.send({ type: "task", status: "completed" })
    stop()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("the confirmation card with a number to give", () => {
  it("names whose number it is and masks it until the person shows it", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmCard, {
        taskId: TASK,
        approval: {
          id: "a1",
          payloadHash: "h",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          payload: {
            recipientLabel: "my CA",
            phone: "+919876543210",
            goal: { type: "deliver_message", message: "Ravi will call you." },
            share: { label: "Ravi", phone: "+919123456789" },
            disclosure: "Hello",
          },
        },
      })
    )
    expect(html).toContain("Will give")
    expect(html).toContain("Ravi&#x27;s number")
    expect(html).toContain("+91 91xxx xxx89")
    expect(html).not.toContain("91234 56789")
  })
})
