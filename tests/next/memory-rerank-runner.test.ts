import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"

// NT-MEM-05 through the real runner (memory v2 on): with next.memoryRerank
// off, or on without next.embeddingModel, nothing is embedded or queued and
// the prompt is the same; with both, one rerank per task and an embed job.

const seen = vi.hoisted(() => ({ prompts: [] as string[], reranks: [] as string[] }))

vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        const system = options.prompt.find((m) => m.role === "system")
        seen.prompts.push(system && "content" in system ? String(system.content) : "")
        const { say } = await import("../operator/golden/harness")
        return { stream: simulateReadableStream({ chunks: say("Hi.") as never[] }) }
      },
    }),
}))
vi.mock("@/lib/memory/embed", async (original) => {
  const real = await original<typeof import("@/lib/memory/embed")>()
  const fake: import("@/lib/memory/embed").Embedder = async (_model, input) => ({
    vectors: input.map(() => Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0))),
    tokens: 1,
    costMicroUsd: 1,
  })
  return {
    ...real,
    rerankByMeaning: (...[options, lists]: Parameters<typeof real.rerankByMeaning>) => {
      seen.reranks.push(options.query)
      return real.rerankByMeaning(options, lists, fake)
    },
  }
})

import { switches, world } from "../operator/golden/harness"

const ENV = [
  "KRIYA_AGENTS_MEMORY_V2",
  "KRIYA_NEXT_MEMORY_RERANK",
  "KRIYA_NEXT_EMBEDDING_MODEL",
  "KRIYA_MAINTENANCE_CAP_MICRO_USD",
]
const set = (values: Record<string, string>) => {
  for (const key of ENV) delete process.env[key]
  Object.assign(process.env, values)
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}
afterEach(() => {
  set({})
  switches(false)
})

describe("NT-MEM-05 next.memoryRerank in the runner", () => {
  it("off or without a model changes nothing; with both, reranks and queues embeddings", async () => {
    const w = await world()
    await w.q(
      `insert into kriya.memories (id, user_id, agent_id, content, embedding, embedding_model, embedded_at)
       values ('n1', $1, 'a1', 'Rent is ₹22,000 a month', array_fill(1::real, array[64]), 'test/embed-64', now()),
              ('n2', $1, 'a1', 'Likes ginger tea', array_fill(0::real, array[64]), 'test/embed-64', now())`,
      [w.user]
    )
    const base = {
      KRIYA_AGENTS_MEMORY_V2: "on",
      KRIYA_MAINTENANCE_CAP_MICRO_USD: "100000",
    }
    const jobs = async () =>
      (await w.q("select 1 from kriya.maintenance_jobs where kind = 'embed_notes'"))
        .length

    set(base)
    await w.turn("किराया कितना है?")
    set({ ...base, KRIYA_NEXT_MEMORY_RERANK: "on" })
    await w.turn("किराया कितना है?")
    set({ ...base, KRIYA_NEXT_EMBEDDING_MODEL: "test/embed-64" })
    await w.turn("किराया कितना है?")
    expect(seen.reranks).toEqual([])
    expect(await jobs()).toBe(0)
    // Same words in each prompt except the date line memory v2 adds
    const strip = (p: string) => p.replace(/\d{4}-\d{2}-\d{2}[^\n]*/g, "")
    expect(new Set(seen.prompts.map(strip)).size).toBe(1)

    set({
      ...base,
      KRIYA_NEXT_MEMORY_RERANK: "on",
      KRIYA_NEXT_EMBEDDING_MODEL: "test/embed-64",
    })
    await w.turn("किराया कितना है?")
    expect(seen.reranks).toEqual(["किराया कितना है?"])
    expect(await jobs()).toBe(1)
    const usage = await w.q(
      "select kind from kriya.resource_usage where kind = 'embedding_tokens'"
    )
    expect(usage).toHaveLength(1)
  })
})
