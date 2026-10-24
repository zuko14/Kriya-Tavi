import { tool, type ToolSet } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { z } from "zod"

import { CAPABILITIES, isIdempotentRead } from "@/lib/agent/capabilities"
import { ConnectorError } from "@/lib/connectors"
import {
  AppUnavailableError,
  BREAKER,
  assertClosed,
  record,
  reset,
} from "@/lib/reliability/breaker"
import {
  isTransient,
  retryTransient,
  TransientError,
  wrapReads,
} from "@/lib/reliability/retry"

// Reliability (track N, N4, ND-05): retries only for idempotent reads, a
// per-system circuit breaker, nothing else touched. NT-REL-01, 02, 03, 05, 06.

beforeEach(() => {
  reset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

const unavailable = () => new ConnectorError("The request failed (503).")

describe("isTransient", () => {
  it("is true for 429/502/503/504, timeouts and network failures only", () => {
    expect(isTransient(new ConnectorError("The request failed (503)."))).toBe(true)
    expect(
      isTransient(new ConnectorError("Searching Gmail failed (429): slow down"))
    ).toBe(true)
    expect(isTransient(new TransientError(504))).toBe(true)
    expect(isTransient(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(
      true
    )
    expect(isTransient(new TypeError("fetch failed"))).toBe(true)
    expect(isTransient(new Response(null, { status: 502 }))).toBe(true)
    // Not worth repeating: the answer would be the same
    expect(isTransient(new ConnectorError("The request failed (404)."))).toBe(false)
    expect(isTransient(new ConnectorError("The request failed (400)."))).toBe(false)
    expect(isTransient(new ConnectorError("Google access has stopped working."))).toBe(
      false
    )
    expect(isTransient(new Error("boom"))).toBe(false)
    expect(isTransient("503")).toBe(false)
  })
})

describe("retryTransient (NT-REL-02)", () => {
  it("succeeds on the third attempt after waiting 500 then 1500 ms", async () => {
    let calls = 0
    const run = vi.fn(async () => {
      calls++
      if (calls < 3) throw unavailable()
      return "ok"
    })
    const result = retryTransient(run)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe("ok")
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("gives up after three attempts and throws the last error", async () => {
    const run = vi.fn(async () => {
      throw unavailable()
    })
    const result = retryTransient(run).catch((error) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toBeInstanceOf(ConnectorError)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("doesn't retry an error that isn't transient", async () => {
    const run = vi.fn(async () => {
      throw new ConnectorError("The request failed (404).")
    })
    await expect(retryTransient(run)).rejects.toThrow(/404/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("doesn't retry when Retry-After is above 5 s, and waits it out when shorter", async () => {
    const slow = vi.fn(async () => {
      throw new TransientError(429, 6_000)
    })
    await expect(retryTransient(slow)).rejects.toBeInstanceOf(TransientError)
    expect(slow).toHaveBeenCalledTimes(1)

    let calls = 0
    const short = vi.fn(async () => {
      if (++calls === 1) throw new TransientError(429, 3_000)
      return "ok"
    })
    const result = retryTransient(short)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(short).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe("ok")
  })
})

describe("the breaker (NT-REL-03)", () => {
  it("opens for one system after five transient failures in 60 s, then closes", () => {
    const t = 1_000_000
    for (let i = 0; i < BREAKER.failures - 1; i++) record("google", t + i)
    expect(() => assertClosed("google", t + 10)).not.toThrow()
    record("google", t + 10)
    expect(() => assertClosed("google", t + 11)).toThrow(AppUnavailableError)
    expect(() => assertClosed("google", t + 11)).toThrow(
      "Google isn't responding; Kriya stopped trying for a minute."
    )
    // Another app is unaffected
    expect(() => assertClosed("notion", t + 11)).not.toThrow()
    // Closed again after 60 s
    expect(() => assertClosed("google", t + 10 + BREAKER.openMs - 1)).toThrow()
    expect(() => assertClosed("google", t + 10 + BREAKER.openMs)).not.toThrow()
  })

  it("counts only failures inside the window", () => {
    const t = 2_000_000
    for (let i = 0; i < 4; i++) record("github", t + i)
    // The fifth comes after the first four have aged out: not five in 60 s
    record("github", t + BREAKER.windowMs + 10)
    expect(() => assertClosed("github", t + BREAKER.windowMs + 11)).not.toThrow()
  })
})

// A belt shaped like the real one: names from the capability registry
const reads = ["calendar_events", "gmail_read", "notion_search"]
const notReads = [
  "calendar_create_event", // side effect
  "gmail_draft", // side effect
  "web_fetch", // R0 but metered per call
  "ledger_list", // database read
  "memory_write", // R1
  "browser_open", // its own service
]
type Run = (...args: unknown[]) => Promise<unknown>
function belt() {
  const original: Record<string, Mock<Run>> = {}
  const tools: ToolSet = {}
  for (const name of [...reads, ...notReads]) {
    original[name] = vi.fn<Run>().mockResolvedValue(name)
    tools[name] = tool({
      description: `does ${name}`,
      inputSchema: z.object({ q: z.string().optional() }),
      execute: (input, options) => original[name](input, options),
    })
  }
  return { tools, original }
}
const systemOf = (name: string) => CAPABILITIES[name]?.system ?? "kriya"

describe("wrapReads (NT-REL-01, 05, 06)", () => {
  it("wraps only R0, non-side-effect, idempotent reads", () => {
    const { tools } = belt()
    const before = Object.fromEntries(
      Object.entries(tools).map(([name, t]) => [name, t.execute])
    )
    wrapReads(tools, systemOf, isIdempotentRead)
    for (const name of reads) expect(tools[name].execute, name).not.toBe(before[name])
    for (const name of notReads) expect(tools[name].execute, name).toBe(before[name])
  })

  it("names exactly the v1 reads of ND-05 as idempotent", () => {
    const idempotent = Object.values(CAPABILITIES)
      .filter((c) => c.idempotent)
      .map((c) => c.tool)
      .sort()
    expect(idempotent).toEqual(
      [
        "calendar_events",
        "drive_read",
        "drive_search",
        "github_read_issue",
        "github_read_pr",
        "github_search",
        "gmail_read",
        "gmail_search",
        "instagram_insights",
        "notion_read",
        "notion_search",
        "sheets_read",
        "youtube_stats",
      ].sort()
    )
    for (const c of Object.values(CAPABILITIES).filter((c) => c.idempotent)) {
      expect(c.risk, c.tool).toBe("R0")
      expect(c.sideEffect, c.tool).toBe(false)
      expect(c.grantable, c.tool).toBe(false)
    }
  })

  it("keeps every name, description and schema as it was", () => {
    const { tools } = belt()
    const shape = (set: ToolSet) =>
      JSON.stringify(
        Object.entries(set).map(([name, t]) => [name, t.description, t.inputSchema])
      )
    const before = shape(tools)
    wrapReads(tools, systemOf, isIdempotentRead)
    expect(shape(tools)).toBe(before)
  })

  it("retries a flaky wrapped read and passes the same input and options", async () => {
    const { tools, original } = belt()
    let calls = 0
    original.gmail_read.mockImplementation(async () => {
      if (++calls < 3) throw unavailable()
      return "mail"
    })
    wrapReads(tools, systemOf, isIdempotentRead)
    const options = { toolCallId: "c1", messages: [] }
    const result = tools.gmail_read.execute!({ q: "x" }, options as never)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await result).toBe("mail")
    expect(original.gmail_read).toHaveBeenCalledTimes(3)
    expect(original.gmail_read).toHaveBeenLastCalledWith({ q: "x" }, options)
  })

  it("fails fast with the typed message once the app's breaker is open", async () => {
    const { tools, original } = belt()
    original.gmail_read.mockRejectedValue(unavailable())
    wrapReads(tools, systemOf, isIdempotentRead)
    // Five calls, each failing after its own three attempts
    for (let i = 0; i < BREAKER.failures; i++) {
      const run = tools.gmail_read.execute!({}, {
        toolCallId: `c${i}`,
        messages: [],
      } as never)
      const settled = Promise.resolve(run).catch((error) => error)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await settled).toBeInstanceOf(ConnectorError)
    }
    original.gmail_read.mockClear()
    await expect(
      tools.gmail_read.execute!({}, { toolCallId: "late", messages: [] } as never)
    ).rejects.toThrow("Google isn't responding; Kriya stopped trying for a minute.")
    expect(original.gmail_read).not.toHaveBeenCalled()
    // Notion shares nothing with Google's breaker
    original.notion_search.mockResolvedValue("pages")
    await expect(
      tools.notion_search.execute!({}, { toolCallId: "n", messages: [] } as never)
    ).resolves.toBe("pages")
  })

  it("never opens the breaker for failures that aren't transient", async () => {
    const { tools, original } = belt()
    original.gmail_read.mockRejectedValue(new ConnectorError("The request failed (404)."))
    wrapReads(tools, systemOf, isIdempotentRead)
    for (let i = 0; i < BREAKER.failures * 2; i++) {
      await expect(
        tools.gmail_read.execute!({}, { toolCallId: `c${i}`, messages: [] } as never)
      ).rejects.toThrow(/404/)
    }
    expect(() => assertClosed("google")).not.toThrow()
    expect(original.gmail_read).toHaveBeenCalledTimes(BREAKER.failures * 2)
  })
})
