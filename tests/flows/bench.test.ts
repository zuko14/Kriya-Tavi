import fs from "node:fs"

import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The graph benchmark suite (IMPLEMENTATION_PLAN "Benchmarks"). Correctness is
// asserted; timings are printed for status.md. PGlite and a scripted model:
// these measure orchestration overhead, never model quality or cost, which
// need real models (SO-08).

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "", email: null }),
  isOwner: async () => false,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        const { respond } = await import("../operator/golden/harness")
        return {
          stream: simulateReadableStream({
            chunks: respond(JSON.stringify(options.prompt)) as never[],
          }),
        }
      },
    }),
}))

import { compile } from "@/lib/flows/compile"
import { decide } from "@/lib/flows/engine"
import { layoutGraph } from "@/lib/flows/layout"
import { reviewFlows } from "@/lib/flows/run"
import { answerGate, createFlow, startRun } from "@/lib/flows/store"

import { model, say, switches, world, type World } from "../operator/golden/harness"
import { agent, check, edge, end, gate, graph, loop, merge, start } from "./fixtures"

let w: World
const results: Record<string, unknown> = {}
const ms = (from: number) => Math.round(performance.now() - from)

async function drive(ids: string[], passes = 400) {
  let count = 0
  for (; count < passes; count++) {
    await w.q(
      "update kriya.flow_runs set review_at = now() where status in ('queued','running')"
    )
    await reviewFlows()
    while (await w.runQueued());
    const open = await w.q<{ n: number }>(
      "select count(*)::int as n from kriya.flow_runs where id = any($1) and status in ('queued','running')",
      [ids]
    )
    if (open[0].n === 0) return count + 1
  }
  throw new Error("didn't settle")
}

const statusOf = async (id: string) =>
  (
    await w.q<{ status: string }>("select status from kriya.flow_runs where id = $1", [
      id,
    ])
  )[0].status

const go = async (g: ReturnType<typeof graph>, inputs = {}) =>
  startRun(w.user, await createFlow(w.user, { name: "Bench", graph: g }), { inputs })

beforeEach(async () => {
  process.env.KRIYA_STUDIO_FLOWS = "on"
  process.env.KRIYA_STUDIO_DAILY_RUNS = "9999"
  w = await world()
  await w.q("update kriya.plans set max_tasks_per_day = 100000")
  model.script = () => say("Done, with enough words to pass a rule.")
})

afterEach(() => {
  delete process.env.KRIYA_STUDIO_FLOWS
  delete process.env.KRIYA_STUDIO_DAILY_RUNS
  switches(false)
})

const chain = (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`)
  return graph(
    [start(), ...ids.map((id) => agent(id)), end()],
    [
      edge("start", ids[0]),
      ...ids.slice(1).map((id, i) => edge(ids[i], id)),
      edge(ids.at(-1)!, "end"),
    ]
  )
}

describe("ST-BENCH", { timeout: 120_000 }, () => {
  it("sequential, against the same tasks on the plain queue", async () => {
    const n = 5
    const t0 = performance.now()
    const id = await go(chain(n))
    const passes = await drive([id])
    const flow = ms(t0)
    expect(await statusOf(id)).toBe("completed")
    const t1 = performance.now()
    for (let i = 0; i < n; i++) await w.turn(`Task ${i}`)
    const plain = ms(t1)
    results.sequential = { nodes: n, flowMs: flow, plainTurnsMs: plain, passes }
  })

  it("conditional branch and merge", async () => {
    const t0 = performance.now()
    const id = await go(
      graph(
        [
          start(),
          agent("a"),
          check("c", "{{a}}", "enough"),
          agent("yes"),
          agent("no"),
          merge("m"),
          end(),
        ],
        [
          edge("start", "a"),
          edge("a", "c"),
          edge("c", "yes", "pass"),
          edge("c", "no", "fail"),
          edge("yes", "m"),
          edge("no", "m"),
          edge("m", "end"),
        ]
      )
    )
    await drive([id])
    expect(await statusOf(id)).toBe("completed")
    results.branch = { ms: ms(t0) }
  })

  it("parallel DAG", async () => {
    const ids = ["a", "b", "c", "d"]
    const t0 = performance.now()
    const id = await go(
      graph(
        [start(), ...ids.map((x) => agent(x)), merge("m"), end()],
        [
          ...ids.map((x) => edge("start", x)),
          ...ids.map((x) => edge(x, "m")),
          edge("m", "end"),
        ]
      )
    )
    const passes = await drive([id])
    expect(await statusOf(id)).toBe("completed")
    results.parallel = { branches: 4, ms: ms(t0), passes }
  })

  it("bounded loop", async () => {
    model.script = () => say("Never the magic word")
    let n = 0
    model.script = () => say(`Attempt ${n++}`)
    const t0 = performance.now()
    const id = await go(
      graph(
        [
          start(),
          loop("l", "c", 4),
          agent("a", "x", "l"),
          check("c", "{{a}}", "impossible", "l"),
          agent("r"),
          end(),
        ],
        [
          edge("start", "l"),
          edge("a", "c"),
          edge("l", "end", "done"),
          edge("l", "r", "exhausted"),
          edge("r", "end"),
        ]
      )
    )
    await drive([id])
    const rows = await w.q("select 1 from kriya.flow_node_runs where node_id = 'a'")
    expect(rows).toHaveLength(4)
    results.loop = { rounds: 4, ms: ms(t0) }
  })

  it("tool failure and repair through the error route", async () => {
    const t0 = performance.now()
    const id = await go(
      graph(
        [start(), agent("a"), agent("fix"), end()],
        [
          edge("start", "a"),
          edge("a", "end"),
          edge("a", "fix", "error"),
          edge("fix", "end"),
        ]
      )
    )
    await w.q("update kriya.flow_runs set review_at = now()")
    await reviewFlows()
    await w.q(
      "update kriya.tasks set status = 'failed', error = 'Down', finished_at = now() where status = 'queued'"
    )
    await drive([id])
    expect(await statusOf(id)).toBe("completed")
    results.repair = { ms: ms(t0) }
  })

  it("human approval and resume", async () => {
    const id = await go(
      graph(
        [start(), gate("g"), agent("a"), end()],
        [edge("start", "g"), edge("g", "a", "approved"), edge("a", "end")]
      )
    )
    await drive([id])
    expect(await statusOf(id)).toBe("waiting")
    const [row] = await w.q<{ id: string }>(
      "select id from kriya.flow_node_runs where node_id = 'g'"
    )
    const t0 = performance.now()
    await answerGate(w.user, row.id, true)
    await drive([id])
    expect(await statusOf(id)).toBe("completed")
    results.gate = { resumeMs: ms(t0) }
  })

  it("resume after a lost worker: nothing runs twice", async () => {
    const id = await go(chain(3))
    await w.q("update kriya.flow_runs set review_at = now()")
    await reviewFlows()
    // The worker dies holding its lease; the run is seen again when it lapses
    await w.q(
      "update kriya.flow_runs set review_at = now() + interval '20 seconds' where id = $1",
      [id]
    )
    expect((await reviewFlows()).reviewed).toBe(0)
    await drive([id])
    expect(await statusOf(id)).toBe("completed")
    const twice = await w.q(
      "select node_id from kriya.flow_node_runs where run_id = $1 group by node_id, scope having count(*) > 1",
      [id]
    )
    expect(twice).toEqual([])
    results.lostWorker = { duplicates: 0 }
  })

  it("high concurrency: 25 runs at once", async () => {
    const flowId = await createFlow(w.user, { name: "Many", graph: chain(2) })
    const t0 = performance.now()
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push(await startRun(w.user, flowId, {}))
    const passes = await drive(ids)
    const done = await w.q(
      "select count(*)::int as n from kriya.flow_runs where id = any($1) and status = 'completed'",
      [ids]
    )
    expect(done[0].n).toBe(25)
    results.concurrent = { runs: 25, agentTasks: 50, ms: ms(t0), passes }
  })

  it("the largest flow: compile, decide and layout", async () => {
    const g = chain(55)
    const t0 = performance.now()
    const { plan } = compile(g, { maxAgentRuns: 100 })
    const compileMs = performance.now() - t0
    const t1 = performance.now()
    decide(plan!, [])
    const decideMs = performance.now() - t1
    const t2 = performance.now()
    await layoutGraph(g)
    results.largest = {
      nodes: g.nodes.length,
      compileMs: Number(compileMs.toFixed(2)),
      decideMs: Number(decideMs.toFixed(2)),
      layoutMs: ms(t2),
    }
    if (process.env.FLOW_BENCH_OUT)
      fs.writeFileSync(process.env.FLOW_BENCH_OUT, JSON.stringify(results, null, 1))
  })
})
