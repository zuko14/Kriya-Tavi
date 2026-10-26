import fs from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// N11 golden for NSC-24 (NG-24): Hindi, Telugu, romanised and Hinglish recall
// through the real runner on today's path (no embeddings, no model). The
// planted note for each question is looked for in the prompt the model gets;
// the count is recorded, never asserted as a quality bar: how good recall is
// on these languages is AS-MEM-ML's M1 (tests/eval/memory-ml.eval.test.ts) and
// the paid rerank comparison (status.md, N9), not a pass mark in npm test.

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "", email: null }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock(
  "@/lib/models",
  async (original) => (await import("./mocks")).modelMock(await original()) as never
)

import { model, say, switches, world, type World } from "../../operator/golden/harness"
import { reset, seen } from "./mocks"

type Case = {
  id: string
  family: string
  query: string
  note: { content: string; kind: string }
}
const cases: Case[] = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "tests/eval/scenarios/AS-MEM-ML/AS-MEM-ML.json"),
    "utf8"
  )
)

const pool: { content: string; kind: string }[] = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "tests/eval/scenarios/AS-MEM/_pool.json"),
    "utf8"
  )
)

let w: World
beforeEach(async () => {
  reset()
  w = await world()
  // 30 questions: more than a day's tasks on the free plan (a limit this isn't testing)
  await w.q("update kriya.plans set max_tasks_per_day = 1000")
  process.env.KRIYA_AGENTS_MEMORY_V2 = "on"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
})
afterEach(() => {
  delete process.env.KRIYA_AGENTS_MEMORY_V2
  switches(false)
  model.script = () => say("Done.")
})

describe("NG-24 NSC-24: asking in Hindi, Telugu or Hinglish for a note saved earlier", () => {
  it("runs every AS-MEM-ML question through the runner and records how many notes reached the prompt", async () => {
    const byFamily = new Map<string, { hits: number; n: number }>()
    for (const c of cases) {
      // The planted note among the person's 40 ordinary ones, so finding it takes
      // relevance, not just being the only one
      await w.q("delete from kriya.memories")
      for (const [i, note] of pool.entries())
        await w.q(
          "insert into kriya.memories (id, user_id, agent_id, content, kind, updated_at) values ($1, $2, 'a1', $3, $4, now() - make_interval(days => $5))",
          [`p-${c.id}-${i}`, w.user, note.content, note.kind, ((i * 7) % 90) + 1]
        )
      await w.q(
        "insert into kriya.memories (id, user_id, agent_id, content, kind, updated_at) values ($1, $2, 'a1', $3, $4, now() - interval '10 days')",
        [`m-${c.id}`, w.user, c.note.content, c.note.kind]
      )
      await w.turn(c.query)
      const hit = seen.prompts.at(-1)!.includes(c.note.content)
      const family = byFamily.get(c.family) ?? { hits: 0, n: 0 }
      byFamily.set(c.family, { hits: family.hits + (hit ? 1 : 0), n: family.n + 1 })
    }
    const total = [...byFamily.values()].reduce((sum, f) => sum + f.n, 0)
    const hits = [...byFamily.values()].reduce((sum, f) => sum + f.hits, 0)
    // Recorded for status.md; the pass mark for recall quality lives in AS-MEM-ML
    console.log(
      `NG-24: ${hits} of ${total} planted notes in the prompt through the runner (` +
        [...byFamily].map(([name, f]) => `${name} ${f.hits}/${f.n}`).join(", ") +
        ")"
    )
    expect(total).toBe(cases.length)
    expect(byFamily.size).toBeGreaterThanOrEqual(4)
    // The task ran every time, and nothing was claimed for a note that wasn't there
    expect(await w.q("select count(*)::int as n from kriya.tasks")).toEqual([
      { n: total },
    ])
  })
})
