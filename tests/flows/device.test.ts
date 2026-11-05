import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Device flows (ST-DEV, SD-14): a graph becomes a Loop v2 plan and a harness
// profile on the existing run action; the computer's reports become node
// rows. Nothing here changes a mode or a check. On PGlite, through the real
// queue() and the real report path.

const fixtures = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: fixtures.user, email: null }),
  isOwner: async () => false,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

import { compile } from "@/lib/flows/compile"
import { devicePlan, planPrompt } from "@/lib/flows/device"
import { reviewFlows } from "@/lib/flows/run"
import { createFlow, startRun } from "@/lib/flows/store"
import { report } from "@/lib/harness/control"
import { DispatchPayloads } from "@/lib/harness/contract"
import { BASELINE, toEnv } from "@/lib/harness/evolve/profile"
import type { FlowGraph, FlowNode } from "@/lib/flows/graph"

import { switches, world, type World } from "../operator/golden/harness"
import { edge, end, start } from "./fixtures"

const step = (id: string, title = id): FlowNode => ({
  id,
  type: "step",
  title,
  at: { x: 0, y: 0 },
  config: { doneWhen: `${title} works`, files: ["a.js"] },
})

const flow = (profile = BASELINE): FlowGraph => ({
  schema: 1,
  target: "device",
  inputs: [],
  nodes: [
    { ...start(), config: { goal: "Fix the bug" } } as FlowNode,
    step("one", "First"),
    step("two", "Second"),
    step("three", "Third"),
    end(),
  ],
  edges: [
    edge("start", "one"),
    edge("start", "two"),
    edge("one", "three"),
    edge("two", "three"),
    edge("three", "end"),
  ],
  limits: { budgetInr: null },
  profile,
})

describe("the plan", () => {
  it("every `after` points back, as Loop v2 requires", () => {
    const g = flow()
    const plan = devicePlan(g, compile(g).plan!)
    expect(plan.steps.map((s) => [s.title, s.after])).toEqual([
      ["First", []],
      ["Second", []],
      ["Third", [1, 2]],
    ])
    expect(plan.goal).toBe("Fix the bug")
  })

  it("says so without Loop v2, and an older client can follow the words", () => {
    const g = flow()
    const { issues } = compile(g)
    expect(issues.map((i) => i.message).join()).toMatch(/one after another/)
    expect(
      compile(flow({ ...BASELINE, loopV2: true }))
        .issues.map((i) => i.message)
        .join()
    ).not.toMatch(/one after another/)
    expect(planPrompt(devicePlan(g, compile(g).plan!))).toMatch(
      /1\. First\. Done when: First works/
    )
  })

  it("S12: the action has no place for a command, and refuses a protected switch", () => {
    const base = {
      project: "a".repeat(16),
      prompt: "x",
      mode: "ask",
      switches: { loopV2: false, budget: true, anchor: false, browser: true },
    }
    expect(DispatchPayloads.run.safeParse(base).success).toBe(true)
    expect(
      DispatchPayloads.run.safeParse({
        ...base,
        plan: {
          goal: "g",
          steps: [{ title: "t", done_when: "d", files: [], command: "rm -rf /" }],
        },
      }).success
    ).toBe(false)
    expect(
      DispatchPayloads.run.safeParse({
        ...base,
        profile: { id: "abcdefabcdef", env: { ...toEnv(BASELINE), KRIYA_MODE: "full" } },
      }).success
    ).toBe(false)
    expect(
      DispatchPayloads.run.safeParse({
        ...base,
        profile: { id: "abcdefabcdef", env: toEnv(BASELINE) },
      }).success
    ).toBe(true)
  })
})

describe("ST-DEV: a run on the person's computer", () => {
  let w: World
  const DEVICE = "11111111-1111-4111-8111-111111111111"
  const device = () => ({ id: w.user, deviceId: DEVICE }) as never
  const send = (id: string, body: object) => report(device(), id, body as never)

  beforeEach(async () => {
    process.env.KRIYA_STUDIO_FLOWS = "on"
    process.env.KRIYA_STUDIO_DEVICE_FLOWS = "on"
    process.env.KRIYA_HARNESS_API = "on"
    process.env.KRIYA_HARNESS_CONTROL_CENTER = "on"
    w = await world()
    fixtures.user = w.user
    await w.q(
      `insert into kriya.harness_devices (id, user_id, name, platform, token_hash, agent_id)
       values ($1, $2, 'Laptop', 'darwin', $3, 'a1')`,
      [DEVICE, w.user, "b".repeat(64)]
    )
    await w.q(
      `insert into kriya.harness_device_state (device_id, user_id, capabilities, projects, polled_at)
       values ($1, $2, '{}', $3, now())`,
      [
        DEVICE,
        w.user,
        JSON.stringify([{ id: "a".repeat(16), name: "app", path: "~/app", git: true }]),
      ]
    )
  })

  afterEach(() => {
    for (const key of [
      "KRIYA_STUDIO_FLOWS",
      "KRIYA_STUDIO_DEVICE_FLOWS",
      "KRIYA_HARNESS_API",
      "KRIYA_HARNESS_CONTROL_CENTER",
    ])
      delete process.env[key]
    switches(false)
  })

  const begin = async (profile = BASELINE) => {
    const flowId = await createFlow(w.user, {
      name: "Fix",
      graph: flow({ ...profile, loopV2: true }),
    })
    const runId = await startRun(w.user, flowId, {
      device: { deviceId: DEVICE, project: "a".repeat(16), mode: "ask" },
    })
    const [{ dispatch_id: dispatch }] = await w.q<{ dispatch_id: string }>(
      "select dispatch_id from kriya.flow_runs where id = $1",
      [runId]
    )
    await w.q("update kriya.harness_dispatches set status = 'claimed' where id = $1", [
      dispatch,
    ])
    return { runId, dispatch }
  }
  const pass = async () => {
    await w.q("update kriya.flow_runs set review_at = now()")
    await reviewFlows()
  }
  const nodes = (runId: string) =>
    w.q<{ node_id: string; status: string }>(
      "select node_id, status from kriya.flow_node_runs where run_id = $1 order by node_id",
      [runId]
    )
  const status = async (runId: string) =>
    (
      await w.q<{ status: string; error: string | null }>(
        "select status, error from kriya.flow_runs where id = $1",
        [runId]
      )
    )[0]

  it("sends the person's plan and profile on the normal action, in the mode they chose", async () => {
    const { dispatch } = await begin()
    const [row] = await w.q<{ kind: string; payload: Record<string, never> }>(
      "select kind, payload from kriya.harness_dispatches where id = $1",
      [dispatch]
    )
    expect(row.kind).toBe("run")
    expect(row.payload.mode).toBe("ask")
    expect(row.payload.plan).toMatchObject({ goal: "Fix the bug" })
    expect(row.payload.profile).toMatchObject({ env: { KRIYA_LOOP_V2: "on" } })
  })

  it("mirrors step status live, and passes only on every step's own check", async () => {
    const { runId, dispatch } = await begin()
    await send(dispatch, { status: "running" })
    await send(dispatch, {
      status: "running",
      result: {
        plan: [
          { n: 1, title: "First", status: "pass", attempts: 2 },
          {
            n: 2,
            title: "Second",
            status: "fail",
            attempts: 1,
            building: { attempt: 2 },
          },
          { n: 3, title: "Third", status: "not started", attempts: 0 },
        ],
      },
    })
    await pass()
    expect(await nodes(runId)).toEqual([
      { node_id: "one", status: "done" },
      { node_id: "start", status: "done" },
      { node_id: "two", status: "running" },
    ])
    await send(dispatch, {
      status: "done",
      result: {
        exitCode: 0,
        answer: "Done.",
        plan: [1, 2, 3].map((n) => ({ n, title: "x", status: "pass", attempts: 1 })),
      },
    })
    await pass()
    expect((await status(runId)).status).toBe("completed")
    expect((await nodes(runId)).every((n) => n.status === "done")).toBe(true)
  })

  it("a model saying done isn't done: an exit of 0 with a blocked step fails the run", async () => {
    const { runId, dispatch } = await begin()
    await send(dispatch, { status: "running" })
    await send(dispatch, {
      status: "done",
      result: {
        exitCode: 0,
        answer: "All finished!",
        plan: [
          { n: 1, title: "First", status: "pass", attempts: 1 },
          { n: 2, title: "Second", status: "blocked", attempts: 4 },
          { n: 3, title: "Third", status: "skipped", attempts: 0 },
        ],
      },
    })
    await pass()
    expect((await status(runId)).status).toBe("failed")
    const rows = await nodes(runId)
    expect(rows.find((n) => n.node_id === "two")?.status).toBe("failed")
    expect(rows.find((n) => n.node_id === "three")?.status).toBe("skipped")
  })

  it("a computer that fails or stops ends the run with a reason", async () => {
    const { runId, dispatch } = await begin()
    await send(dispatch, { status: "running" })
    await send(dispatch, { status: "failed", result: { error: "No such folder." } })
    await pass()
    expect(await status(runId)).toEqual({ status: "failed", error: "No such folder." })
  })

  it("off, a device flow can't start", async () => {
    delete process.env.KRIYA_STUDIO_DEVICE_FLOWS
    const flowId = await createFlow(w.user, { name: "Fix", graph: flow() })
    await expect(
      startRun(w.user, flowId, {
        device: { deviceId: DEVICE, project: "a".repeat(16), mode: "ask" },
      })
    ).rejects.toThrow(/aren't available/)
  })

  it("a computer that isn't listening is refused at once (CC-D6)", async () => {
    await w.q(
      "update kriya.harness_device_state set polled_at = now() - interval '1 hour'"
    )
    const flowId = await createFlow(w.user, { name: "Fix", graph: flow() })
    await expect(
      startRun(w.user, flowId, {
        device: { deviceId: DEVICE, project: "a".repeat(16), mode: "ask" },
      })
    ).rejects.toThrow()
  })
})
