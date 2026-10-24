import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"

// N4 in the runner: with next.reliability off nothing is wrapped (NT-REL-06);
// with it on, wrapReads runs once and the model sees the same prompt and
// tool definitions (NT-REL-05).

const seen = vi.hoisted(() => ({
  tools: [] as string[],
  prompts: [] as string[],
  wrapped: [] as string[][],
}))

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        seen.tools.push(
          JSON.stringify(
            (options.tools ?? [])
              .map((t) => [t.name, "description" in t ? t.description : null, t])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
          )
        )
        const system = options.prompt.find((m) => m.role === "system")
        seen.prompts.push(system && "content" in system ? String(system.content) : "")
        const { say } = await import("../operator/golden/harness")
        return { stream: simulateReadableStream({ chunks: say("Hi.") as never[] }) }
      },
    }),
}))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock("@/lib/reliability/retry", async (original) => {
  const real = await original<typeof import("@/lib/reliability/retry")>()
  return {
    ...real,
    wrapReads: (...args: Parameters<typeof real.wrapReads>) => {
      seen.wrapped.push(Object.keys(args[0]))
      return real.wrapReads(...args)
    },
  }
})

import { switches, world } from "../operator/golden/harness"

afterEach(() => {
  delete process.env.KRIYA_NEXT_RELIABILITY
  switches(false)
})

const reset = () =>
  ((globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined)

describe("next.reliability in the runner", () => {
  it("installs nothing when off, and changes neither prompt nor tool definitions when on", async () => {
    const w = await world()
    await w.turn("hello")
    process.env.KRIYA_NEXT_RELIABILITY = "off"
    reset()
    await w.turn("hello")
    expect(seen.wrapped).toEqual([])
    expect(seen.tools.at(-1)).toBe(seen.tools.at(-2))
    expect(seen.prompts.at(-1)).toBe(seen.prompts.at(-2))

    process.env.KRIYA_NEXT_RELIABILITY = "on"
    reset()
    await w.turn("hello")
    expect(seen.wrapped).toHaveLength(1)
    expect(seen.wrapped[0]).toContain("gmail_read")
    expect(seen.tools.at(-1)).toBe(seen.tools.at(-3))
    expect(seen.prompts.at(-1)).toBe(seen.prompts.at(-3))
  })
})
