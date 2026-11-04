import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// The Control Center (CONTROL_CENTER.md), HT-CC-*: the daemon's hello, long
// poll, reports and run broadcast on the real routes over PGlite, and every
// check on the person's side before an action is queued.

vi.mock("server-only", () => ({}))

import { POST as helloRoute } from "@/app/api/harness/v1/daemon/hello/route"
import { POST as reportRoute } from "@/app/api/harness/v1/dispatch/[id]/route"
import { GET as nextRoute } from "@/app/api/harness/v1/dispatch/next/route"
import { POST as runsRoute } from "@/app/api/harness/v1/runs/route"
import { cancel, controlCenter, queue, QUEUE_LIMIT } from "@/lib/harness/control"
import { DaemonHelloResponse, DispatchNextResponse } from "@/lib/harness/contract"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "./setup"

let pg: TestDb
let alice: string
let bob: string
let mine: { token: string; deviceId: string }
let other: { token: string; deviceId: string }

const PROJECT = "0123456789abcdef"
const run = (over: Record<string, unknown> = {}) => ({
  project: PROJECT,
  prompt: "Fix the failing test",
  mode: "auto",
  switches: { loopV2: false, budget: true, anchor: false, browser: true },
  ...over,
})
const helloBody = (over: Record<string, unknown> = {}) => ({
  daemonVersion: "0.3.0",
  capabilities: { fullAccess: false, serve: false, handoff: true },
  projects: [
    { id: PROJECT, name: "app", path: "~/Documents/app", git: true },
    { id: "fedcba9876543210", name: "notes", path: "~/notes", git: false },
  ],
  rules: [
    { project: PROJECT, n: 1, text: "Run npm ci before tests", status: "proposed" },
  ],
  ...over,
})
const say = (token: string, body = helloBody()) =>
  helloRoute(call("POST", "/daemon/hello", { token, body }))
const poll = async (token: string) => {
  const res = await nextRoute(call("GET", "/dispatch/next?wait=0", { token }))
  return {
    status: res.status,
    body: res.status === 200 ? DispatchNextResponse.parse(await res.json()) : null,
  }
}
const reportAs = (token: string, id: string, body: unknown) =>
  reportRoute(call("POST", `/dispatch/${id}`, { token, body }))
const statusOf = async (id: string) =>
  (
    await pg.query<{ status: string }>(
      "select status from kriya.harness_dispatches where id = $1",
      [id]
    )
  ).rows[0]?.status

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  alice = await db.createUser()
  bob = await db.createUser()
  mine = await deviceFor(pg, alice)
  other = await deviceFor(pg, bob)
})

beforeEach(async () => {
  harnessEnv({ KRIYA_HARNESS_CONTROL_CENTER: "on", KRIYA_HARNESS_RPM: "600" })
  await pg.query("delete from kriya.harness_runs")
  await pg.query("delete from kriya.harness_dispatches")
  await pg.query("delete from kriya.harness_device_state")
})

describe("HT-CC-01: off means nothing", () => {
  it("every Control Center route answers 404 with the switch off", async () => {
    harnessEnv({ KRIYA_HARNESS_CONTROL_CENTER: undefined })
    expect((await say(mine.token)).status).toBe(404)
    expect((await poll(mine.token)).status).toBe(404)
    expect(
      (await reportAs(mine.token, crypto.randomUUID(), { status: "done" })).status
    ).toBe(404)
    expect(
      (
        await runsRoute(
          call("POST", "/runs", {
            token: mine.token,
            body: { localId: "a", source: "terminal", kind: "run", status: "running" },
          })
        )
      ).status
    ).toBe(404)
  })

  it("routes need a device token", async () => {
    expect(
      (await helloRoute(call("POST", "/daemon/hello", { body: helloBody() }))).status
    ).toBe(401)
    expect((await nextRoute(call("GET", "/dispatch/next"))).status).toBe(401)
  })
})

describe("HT-CC-02: a dispatched action, end to end", () => {
  it("hello → queue → claim → running → done, seen by the person and by no one else", async () => {
    const hello = await say(mine.token)
    expect(hello.status).toBe(200)
    expect(DaemonHelloResponse.parse(await hello.json()).pollSeconds).toBe(25)
    const id = await queue(alice, mine.deviceId, "run", run())
    expect(await statusOf(id)).toBe("queued")
    // Another person's computer never sees it
    await say(other.token)
    expect((await poll(other.token)).body?.dispatch).toBeNull()
    const claimed = await poll(mine.token)
    expect(claimed.body?.dispatch).toMatchObject({ id, kind: "run", payload: run() })
    expect(await statusOf(id)).toBe("claimed")
    // Claimed once: the next poll has nothing
    expect((await poll(mine.token)).body?.dispatch).toBeNull()
    expect((await reportAs(other.token, id, { status: "done" })).status).toBe(404)
    expect((await reportAs(mine.token, id, { status: "running" })).status).toBe(204)
    expect(
      (
        await reportAs(mine.token, id, {
          status: "done",
          result: { exitCode: 0, answer: "Fixed it." },
        })
      ).status
    ).toBe(204)
    expect(await statusOf(id)).toBe("done")
    // Finished stays finished
    expect((await reportAs(mine.token, id, { status: "failed" })).status).toBe(404)
    const view = await controlCenter(alice)
    expect(view.devices[0]).toMatchObject({
      id: mine.deviceId,
      online: true,
      daemonVersion: "0.3.0",
    })
    expect(view.dispatches[0]).toMatchObject({
      id,
      status: "done",
      result: { exitCode: 0, answer: "Fixed it." },
    })
    expect((await controlCenter(bob)).dispatches).toEqual([])
  })

  it("a queued action past its expiry isn't run", async () => {
    await say(mine.token)
    const id = await queue(alice, mine.deviceId, "doctor", {})
    await pg.query(
      "update kriya.harness_dispatches set expires_at = now() - interval '1 second' where id = $1",
      [id]
    )
    expect((await poll(mine.token)).body?.dispatch).toBeNull()
    expect(await statusOf(id)).toBe("expired")
  })
})

describe("HT-CC-03: stopping", () => {
  it("a queued action stops at once; a running one through its computer", async () => {
    await say(mine.token)
    const queued = await queue(alice, mine.deviceId, "doctor", {})
    await cancel(alice, queued)
    expect(await statusOf(queued)).toBe("canceled")
    const running = await queue(alice, mine.deviceId, "run", run())
    await poll(mine.token)
    await reportAs(mine.token, running, { status: "running" })
    await cancel(alice, running)
    expect(await statusOf(running)).toBe("canceling")
    const next = await poll(mine.token)
    expect(next.body?.cancel).toEqual([running])
    // Still "canceling" while it winds down; then canceled
    expect((await reportAs(mine.token, running, { status: "running" })).status).toBe(204)
    expect(await statusOf(running)).toBe("canceling")
    expect((await reportAs(mine.token, running, { status: "canceled" })).status).toBe(204)
    expect(await statusOf(running)).toBe("canceled")
    await expect(cancel(alice, running)).rejects.toThrow(/already finished/)
    await expect(cancel(bob, running)).rejects.toThrow(/isn't there/)
  })
})

describe("HT-CC-04: what the person can't queue", () => {
  it("refuses offline, foreign or signed-out computers, unknown folders, and what the computer doesn't allow", async () => {
    await expect(queue(alice, mine.deviceId, "doctor", {})).rejects.toThrow(
      /isn't listening/
    )
    await say(mine.token)
    await expect(queue(alice, other.deviceId, "doctor", {})).rejects.toThrow(
      /isn't signed in/
    )
    await expect(
      queue(alice, mine.deviceId, "run", run({ project: "aaaaaaaaaaaaaaaa" }))
    ).rejects.toThrow(/isn't one this computer offers/)
    await expect(
      queue(alice, mine.deviceId, "run", run({ mode: "full" }))
    ).rejects.toThrow(/Full access from Kriya is off/)
    await expect(
      queue(alice, mine.deviceId, "serve_start", { project: PROJECT })
    ).rejects.toThrow(/Serving from Kriya is off/)
    await expect(
      queue(alice, mine.deviceId, "handoff", { project: "fedcba9876543210" })
    ).rejects.toThrow(/need a git repository/)
    await expect(
      queue(alice, mine.deviceId, "rule_confirm", { project: PROJECT, n: 9 })
    ).rejects.toThrow(/isn't listed/)
    await expect(
      queue(alice, mine.deviceId, "run", { ...run(), command: "rm -rf /" })
    ).rejects.toThrow(/isn't complete/)
    await expect(queue(alice, mine.deviceId, "run", run({ prompt: "" }))).rejects.toThrow(
      /isn't complete/
    )
    // Allowed on the computer: then it queues
    await say(
      mine.token,
      helloBody({ capabilities: { fullAccess: true, serve: true, handoff: true } })
    )
    expect(await queue(alice, mine.deviceId, "run", run({ mode: "full" }))).toBeTruthy()
    expect(
      await queue(alice, mine.deviceId, "serve_start", { project: PROJECT })
    ).toBeTruthy()
    expect(
      await queue(alice, mine.deviceId, "rule_confirm", { project: PROJECT, n: 1 })
    ).toBeTruthy()
    // A signed-out computer can't be given work
    await pg.query("update kriya.harness_devices set revoked_at = now() where id = $1", [
      mine.deviceId,
    ])
    await expect(queue(alice, mine.deviceId, "doctor", {})).rejects.toThrow(
      /isn't signed in/
    )
    await pg.query("update kriya.harness_devices set revoked_at = null where id = $1", [
      mine.deviceId,
    ])
  })

  it(`at most ${QUEUE_LIMIT} actions in ten minutes`, async () => {
    await say(mine.token)
    for (let i = 0; i < QUEUE_LIMIT; i++) await queue(alice, mine.deviceId, "doctor", {})
    await expect(queue(alice, mine.deviceId, "doctor", {})).rejects.toThrow(
      /Too many actions/
    )
  })

  it("a computer that stopped polling a minute ago is offline", async () => {
    await say(mine.token)
    await pg.query(
      "update kriya.harness_device_state set polled_at = now() - interval '2 minutes'"
    )
    await expect(queue(alice, mine.deviceId, "doctor", {})).rejects.toThrow(
      /isn't listening/
    )
  })
})

describe("HT-CC-05: what kriya processes run, from the terminal", () => {
  it("one row per (computer, local id), updated in place; no foreign dispatch is linked", async () => {
    await say(mine.token)
    const foreign = await (async () => {
      await say(other.token)
      return queue(bob, other.deviceId, "doctor", {})
    })()
    const send = (body: Record<string, unknown>) =>
      runsRoute(call("POST", "/runs", { token: mine.token, body }))
    expect(
      (
        await send({
          localId: "r-1",
          source: "terminal",
          kind: "run",
          mode: "auto",
          switches: { loop: true },
          project: "app",
          status: "running",
          dispatchId: foreign,
        })
      ).status
    ).toBe(204)
    expect(
      (
        await send({
          localId: "r-1",
          source: "terminal",
          kind: "run",
          mode: "auto",
          project: "app",
          status: "completed",
          exitCode: 0,
        })
      ).status
    ).toBe(204)
    const rows = (
      await pg.query<{
        status: string
        exit_code: number
        dispatch_id: string | null
        ended_at: Date | null
      }>("select status, exit_code, dispatch_id, ended_at from kriya.harness_runs")
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: "completed",
      exit_code: 0,
      dispatch_id: null,
    })
    expect(rows[0].ended_at).not.toBeNull()
    // No task text field exists
    expect(
      (
        await send({
          localId: "r-2",
          source: "terminal",
          kind: "run",
          status: "running",
          task: "secret plan",
        })
      ).status
    ).toBe(400)
    expect((await controlCenter(alice)).runs.map((r) => r.status)).toEqual(["completed"])
  })
})

describe("HT-CC-06: a run that stops reporting is lost, not running forever", () => {
  it("running with no heartbeat for three minutes reads as lost", async () => {
    await say(mine.token)
    await runsRoute(
      call("POST", "/runs", {
        token: mine.token,
        body: { localId: "beat", source: "terminal", kind: "run", status: "running" },
      })
    )
    expect((await controlCenter(alice)).runs[0].lost).toBe(false)
    await pg.query(
      "update kriya.harness_runs set updated_at = now() - interval '4 minutes'"
    )
    expect((await controlCenter(alice)).runs[0].lost).toBe(true)
  })
})
