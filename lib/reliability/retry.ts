import type { ToolSet } from "ai"

import { assertClosed, record } from "@/lib/reliability/breaker"

// Transient retries for reads that are safe to repeat (ND-05). Actions are
// never retried here: the queue already refuses to rerun a task that did one.
// No next/* imports (the worker uses this too).

// A provider answer worth trying again: the MCP client (N5) throws this with
// the `Retry-After` it saw
export class TransientError extends Error {
  name = "TransientError"
  constructor(
    public status: number | "timeout" | "network",
    public retryAfterMs?: number
  ) {
    super(`The app is busy (${status}).`)
  }
}

const TRANSIENT_STATUS = new Set([429, 502, 503, 504])
// shortcut: connector errors carry the status only in their message
// ("… failed (503)"), so it is read from there and Retry-After is unknown for
// them; a typed status arrives with the MCP client (N5)
const STATUS_IN_MESSAGE = /\((\d{3})\)/

export function isTransient(error: unknown): boolean {
  if (error instanceof TransientError) return true
  if (error instanceof Response) return TRANSIENT_STATUS.has(error.status)
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError") return true
  if (error instanceof TypeError && error.message === "fetch failed") return true
  if (error.name === "ConnectorError") {
    const status = Number(STATUS_IN_MESSAGE.exec(error.message)?.[1])
    return TRANSIENT_STATUS.has(status)
  }
  return false
}

// A longer wait than this is the provider saying "not now": no retry
const MAX_RETRY_AFTER_MS = 5_000
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function retryTransient<T>(
  run: () => Promise<T>,
  opts: { attempts?: number; delays?: number[] } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3
  const delays = opts.delays ?? [500, 1_500]
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error
      const after = error instanceof TransientError ? error.retryAfterMs : undefined
      if (after !== undefined && after > MAX_RETRY_AFTER_MS) throw error
      await sleep(Math.max(delays[attempt - 1] ?? delays.at(-1) ?? 0, after ?? 0))
    }
  }
}

// Replaces `execute` of the eligible tools with a retrying, breaker-guarded
// version. Name, description and schema are untouched. The caller decides
// eligibility (R0, not a side effect, idempotent): see isIdempotentRead.
export function wrapReads(
  tools: ToolSet,
  systemOf: (name: string) => string,
  eligible: (name: string) => boolean
) {
  for (const [name, original] of Object.entries(tools)) {
    const run = original.execute
    if (!eligible(name) || typeof run !== "function") continue
    const system = systemOf(name)
    tools[name] = {
      ...original,
      execute: async (input: unknown, options: never) => {
        assertClosed(system)
        try {
          return await retryTransient(async () => run(input as never, options))
        } catch (error) {
          if (isTransient(error)) record(system)
          throw error
        }
      },
    } as typeof original
  }
}
