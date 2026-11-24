import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// S-3 task proof (docs/kriya-harness/TASK_PROOF.md), HT-PRF-*: with
// harness.taskProof on, a queued run asks its computer for the proof; what
// comes back is shown only if it parses as RunProof (names and counts, no
// content). Off: payloads and the Control Center are exactly as before.

vi.mock("server-only", () => ({}))

import { POST as helloRoute } from "@/app/api/harness/v1/daemon/hello/route"
import { POST as reportRoute } from "@/app/api/harness/v1/dispatch/[id]/route"
import { GET as nextRoute } from "@/app/api/harness/v1/dispatch/next/route"
import { controlCenter, queue } from "@/lib/harness/control"
import { DispatchNextResponse, RunProof } from "@/lib/harness/contract"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let alice: string
let mine: { token: string; deviceId: string }

const PROJECT = "0123456789abcdef"
const run = (over: Record<string, unknown> = {}) => ({
  project: PROJECT,
  prompt: "Fix the failing test",
  mode: "auto",
  switches: { loopV2: false, budget: true, anchor: false, browser: false },
  ...over,
})
const PROOF = {
  verdict: "verified",
  steps: [
    {
      n: 1,
      title: "Pass the check",
      verdict: "pass",
      attempts: 2,
      builtBy: [
        { level: "worker", name: "Local · qwen2.5-coder:14b", local: true },
        { level: "head", name: "gemini-4-neon" },
      ],
      gates: [{ id: "G-SECRETS", status: "pass" }],
    },
  ],
  changes: {
    files: [{ path: "src/orders.ts", status: "modified", added: 12, deleted: 3 }],
    count: 1,
    added: 12,
    deleted: 3,
  },
}

async function claimOne() {
  await helloRoute(
    call("POST", "/daemon/hello", {
      token: mine.token,
      body: {
        daemonVersion: "2.0.1",
        capabilities: { fullAccess: false, serve: false, handoff: true },
        projects: [{ id: PROJECT, name: "app", path: "~/app", git: true }],
        rules: [],
      },
    })
  )
  const id = await queue(alice, mine.deviceId, "run", run({ proof: true }))
  const res = await nextRoute(call("GET", "/dispatch/next?wait=0", { token: mine.token }))
  const { dispatch } = DispatchNextResponse.parse(await res.json())
  return { id, payload: dispatch!.payload }
}
const report = (id: string, body: unknown) =>
  reportRoute(call("POST", `/dispatch/${id}`, { token: mine.token, body }))
const rowOf = async (id: string) =>
  (await controlCenter(alice)).dispatches.find((d) => d.id === id)!

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  alice = await db.createUser()
  mine = await deviceFor(pg, alice)
})
beforeEach(async () => {
  harnessEnv({ KRIYA_HARNESS_CONTROL_CENTER: "on", KRIYA_HARNESS_RPM: "600" })
  await pg.query("delete from kriya.harness_dispatches")
  await pg.query("delete from kriya.harness_device_state")
})

describe("HT-PRF-01: off means nothing", () => {
  it("a run's payload carries no proof, even if the browser sends one, and no proof is shown", async () => {
    const { id, payload } = await claimOne()
    expect(payload).not.toHaveProperty("proof")
    await report(id, { status: "running" })
    await report(id, { status: "done", result: { exitCode: 0, proof: PROOF } })
    expect((await rowOf(id)).proof).toBeNull()
  })
})

describe("HT-PRF-02: on", () => {
  it("Kriya sets proof: true itself, and the computer's report is shown as it parsed", async () => {
    harnessEnv({
      KRIYA_HARNESS_CONTROL_CENTER: "on",
      KRIYA_HARNESS_RPM: "600",
      KRIYA_HARNESS_TASK_PROOF: "on",
    })
    const { id, payload } = await claimOne()
    expect(payload).toMatchObject({ proof: true })
    await report(id, { status: "running", result: { plan: [], proof: { steps: [] } } })
    expect((await rowOf(id)).proof).toEqual({ steps: [] })
    await report(id, {
      status: "done",
      result: { exitCode: 0, answer: "Done.", proof: PROOF },
    })
    expect((await rowOf(id)).proof).toEqual(PROOF)
  })

  it("a report that doesn't parse is not shown: content, unknown fields, bad gates", async () => {
    harnessEnv({
      KRIYA_HARNESS_CONTROL_CENTER: "on",
      KRIYA_HARNESS_RPM: "600",
      KRIYA_HARNESS_TASK_PROOF: "on",
    })
    for (const bad of [
      { ...PROOF, diff: "--- a/src/orders.ts\n+secret" },
      {
        ...PROOF,
        changes: {
          ...PROOF.changes,
          files: [{ ...PROOF.changes.files[0], content: "x" }],
        },
      },
      {
        ...PROOF,
        steps: [{ ...PROOF.steps[0], gates: [{ id: "rm -rf", status: "pass" }] }],
      },
      { ...PROOF, verdict: "done (the model says so)" },
    ]) {
      expect(RunProof.safeParse(bad).success).toBe(false)
      await pg.query("delete from kriya.harness_dispatches")
      const { id } = await claimOne()
      await report(id, { status: "running" })
      await report(id, { status: "done", result: { exitCode: 0, proof: bad } })
      expect((await rowOf(id)).proof).toBeNull()
    }
  })
})
