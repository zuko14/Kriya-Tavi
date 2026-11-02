import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { RunnerClient, RunnerRequestError } from "@/lib/cloud/client"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"
import { runnerToken } from "@/lib/cloud/token"
import { setFileStoreForTests } from "@/lib/files"
import { createRunner } from "@/runner"

import { createTestDb, createUser, type TestDb } from "../db/harness"
import {
  BASE_SHA,
  FakeProvider,
  fixtureSource,
  memoryStore,
  textOf,
} from "./fake-provider"

// One task's workspace on a real Postgres (TOOLS_AND_CONTRACTS §4,
// TEST_STRATEGY CT-WS-*): the fake provider's sandboxes are the real runner
// in-process, checkpoints go to an in-memory store.

const hasGit = spawnSync("git", ["--version"]).status === 0

const SETTINGS: CloudSettings = {
  image: "kriya-runner:test",
  size: "2c-4g",
  network: "registries",
  commandTimeoutSeconds: 60,
  maxRunning: 10,
  maxImportMb: 50,
  maxCheckpointMb: 10,
  costMicroUsdPerHour: null,
}

let pg: TestDb
let user: string
let other: string
let provider: FakeProvider

beforeAll(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  user = await createUser(pg)
  other = await createUser(pg)
  process.env.KRIYA_WORKSPACE_SECRET = "s".repeat(43)
  // Never the real bucket: cases without their own store have none
  setFileStoreForTests(null)
})

beforeEach(async () => {
  provider = new FakeProvider()
  await pg.query("update kriya.plans set workspace_minutes = 600")
})

afterEach(async () => {
  await provider.closeAll()
})

async function task(userId: string, tag: string) {
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g') on conflict do nothing",
    [`agent-${tag}`, userId]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3) on conflict do nothing",
    [`thread-${tag}`, userId, `agent-${tag}`]
  )
  // One active task per thread: the earlier one has finished
  await pg.query(
    "update kriya.tasks set status = 'succeeded' where thread_id = $1 and status in ('queued', 'running')",
    [`thread-${tag}`]
  )
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, agent_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, $2, $3, '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [userId, `thread-${tag}`, `agent-${tag}`]
  )
  return { id: rows[0].id, userId, threadId: `thread-${tag}`, agentId: `agent-${tag}` }
}

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows[0]

const backdate = (taskId: string, seconds: number) =>
  pg.query(
    `update kriya.workspace_sessions set opened_at = now() - make_interval(secs => $2)
     where task_id = $1 and status = 'open'`,
    [taskId, seconds]
  )

describe.skipIf(!hasGit)("TaskWorkspace", () => {
  it("CT-WS-01: no workspace call, no provider call and no session", async () => {
    const t = await task(user, "w01")
    const ws = new TaskWorkspace(provider, t, SETTINGS)
    expect(await ws.describe()).toBeNull()
    await ws.heartbeat()
    await ws.close(null)
    expect(provider.calls).toEqual([])
    expect(
      await one(
        "select count(*)::int as n from kriya.workspace_sessions where task_id = $1",
        [t.id]
      )
    ).toEqual({ n: 0 })
    expect(
      await one("select count(*)::int as n from kriya.workspaces where thread_id = $1", [
        t.threadId,
      ])
    ).toEqual({ n: 0 })
  })

  it("CT-WS-02: the session row comes before the provider; refusals are plain", async () => {
    await pg.query("update kriya.plans set workspace_minutes = 0")
    const t1 = await task(user, "w02a")
    const refused = new TaskWorkspace(provider, t1, SETTINGS)
    await expect(refused.open({})).rejects.toThrow(
      "This month's cloud workspace minutes are used up."
    )
    expect(provider.calls).toEqual([])
    expect(
      await one("select status from kriya.workspaces where thread_id = $1", [t1.threadId])
    ).toEqual({ status: "new" })
    await pg.query("update kriya.plans set workspace_minutes = 600")

    const busy = new TaskWorkspace(provider, await task(user, "w02b"), {
      ...SETTINGS,
      maxRunning: 0,
    })
    await expect(busy.open({})).rejects.toThrow(
      "Cloud workspaces are busy right now; try again in a few minutes."
    )
    expect(provider.calls).toEqual([])

    const t3 = await task(user, "w02c")
    const unknown = new TaskWorkspace(provider, { ...t3, id: randomUUID() }, SETTINGS)
    await expect(unknown.open({})).rejects.toThrow(
      "The workspace couldn't be started for this task."
    )

    const t4 = await task(user, "w02d")
    const seen: number[] = []
    provider.beforeCreate = async () => {
      seen.push(
        (
          await one<{ n: number }>(
            "select count(*)::int as n from kriya.workspace_sessions where task_id = $1 and status = 'open'",
            [t4.id]
          )
        ).n
      )
    }
    const ws = new TaskWorkspace(provider, t4, SETTINGS)
    expect(await ws.open({})).toMatchObject({
      repo: null,
      status: "running",
      restored: false,
    })
    expect(seen).toEqual([1])
    await ws.close(null)
  })

  it("CT-WS-03: the heartbeat extends the sandbox and moves heartbeat_at", async () => {
    const t = await task(user, "w03")
    const ws = new TaskWorkspace(provider, t, SETTINGS)
    await ws.open({})
    await pg.query(
      "update kriya.workspace_sessions set heartbeat_at = now() - interval '1 hour' where task_id = $1",
      [t.id]
    )
    await ws.heartbeat()
    expect(provider.ops()).toContain("extend")
    expect(
      await one(
        "select heartbeat_at > now() - interval '1 minute' as fresh from kriya.workspace_sessions where task_id = $1",
        [t.id]
      )
    ).toEqual({ fresh: true })
    await ws.close(null)
  })

  it("CT-WS-04: the end checkpoints when changed, pauses, and meters the time", async () => {
    const { store, objects } = memoryStore()
    const t = await task(user, "w04")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
    await ws.open({})
    const client = await ws.client()
    await client.write({ path: "a.txt", content: "hi\n" })
    await backdate(t.id, 3600)
    await ws.close(null)

    expect(provider.ops().at(-1)).toBe("pause")
    const row = await one<Record<string, unknown>>(
      "select id, status, checkpoint_path, checkpoint_sha256, checkpoint_bytes, checkpoint_seq, changes from kriya.workspaces where thread_id = $1",
      [t.threadId]
    )
    expect(row.status).toBe("paused")
    expect(row.checkpoint_path).toBe(`workspaces/${user}/${row.id}/1-1.patch`)
    const patch = objects.get(String(row.checkpoint_path))!
    expect(row.checkpoint_sha256).toBe(createHash("sha256").update(patch).digest("hex"))
    expect(Number(row.checkpoint_bytes)).toBe(patch.length)
    expect(row.changes).toEqual({ files: 1, added: 1, removed: 0 })
    const session = await one<{ status: string; close_reason: string; seconds: number }>(
      "select status, close_reason, seconds from kriya.workspace_sessions where task_id = $1",
      [t.id]
    )
    expect(session).toMatchObject({ status: "closed", close_reason: "end" })
    expect(session.seconds).toBeGreaterThanOrEqual(3600)
    const usage = await pg.query<{
      kind: string
      quantity: number
      cost_micro_usd: number | null
    }>(
      "select kind, quantity, cost_micro_usd from kriya.resource_usage where task_id = $1 order by kind",
      [t.id]
    )
    expect(usage.rows).toEqual([
      {
        kind: "workspace_seconds",
        quantity: session.seconds,
        cost_micro_usd: null,
      },
      {
        kind: "workspace_storage_bytes",
        quantity: patch.length,
        cost_micro_usd: null,
      },
    ])

    // Next task, same thread, nothing changed: no new checkpoint; priced
    const t2 = { ...(await task(user, "w04")), threadId: t.threadId }
    const priced = new TaskWorkspace(
      provider,
      t2,
      { ...SETTINGS, costMicroUsdPerHour: 180_000 },
      { store }
    )
    await priced.client()
    await backdate(t2.id, 3600)
    await priced.close(null)
    expect(objects.size).toBe(1)
    expect(
      await one("select checkpoint_seq from kriya.workspaces where id = $1", [row.id])
    ).toEqual({ checkpoint_seq: 1 })
    const second = await one<{ seconds: number }>(
      "select seconds from kriya.workspace_sessions where task_id = $1",
      [t2.id]
    )
    expect(
      await one(
        "select cost_micro_usd from kriya.resource_usage where task_id = $1 and kind = 'workspace_seconds'",
        [t2.id]
      )
    ).toEqual({ cost_micro_usd: Math.round((second.seconds * 180_000) / 3600) })
  })

  it("CT-WS-05: shutdown pauses without a checkpoint; the next task resumes the same sandbox", async () => {
    const { store, objects } = memoryStore()
    const t = await task(user, "w05")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
    await ws.open({})
    await (await ws.client()).write({ path: "x.txt", content: "x" })
    await ws.close("shutdown")
    expect(provider.ops()).toEqual(["create", "pause"])
    expect(objects.size).toBe(0)
    const row = await one<{ status: string; provider_ref: string; generation: number }>(
      "select status, provider_ref, generation from kriya.workspaces where thread_id = $1",
      [t.threadId]
    )
    expect(row).toMatchObject({ status: "paused", generation: 1 })
    expect(
      await one("select close_reason from kriya.workspace_sessions where task_id = $1", [
        t.id,
      ])
    ).toEqual({ close_reason: "shutdown" })

    const t2 = { ...(await task(user, "w05")), threadId: t.threadId }
    const next = new TaskWorkspace(provider, t2, SETTINGS, { store })
    const client = await next.client()
    expect(provider.calls.at(-1)).toEqual({ op: "resume", ref: row.provider_ref })
    expect(provider.ops().filter((op) => op === "create")).toHaveLength(1)
    expect(await textOf(client, "x.txt")).toBe("x")
    await next.close("lease_lost")
    expect(
      await one("select generation, status from kriya.workspaces where thread_id = $1", [
        t.threadId,
      ])
    ).toEqual({ generation: 1, status: "paused" })
  })

  it("CT-WS-06: a runner that never answers: cleaned up, metered, plain error", async () => {
    provider.unhealthy = true
    const t = await task(user, "w06a")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { healthMs: 500 })
    await expect(ws.open({})).rejects.toThrow(
      "The workspace couldn't be started for this task."
    )
    expect(provider.ops()).toEqual(["create", "destroy"])
    expect(
      await one(
        "select status, provider_ref from kriya.workspaces where thread_id = $1",
        [t.threadId]
      )
    ).toEqual({ status: "failed", provider_ref: null })
    const failed = await one<{ status: string; seconds: number | null }>(
      "select status, seconds from kriya.workspace_sessions where task_id = $1",
      [t.id]
    )
    expect(failed.status).toBe("failed")
    expect(failed.seconds).not.toBeNull()
    expect(
      await one(
        "select count(*)::int as n from kriya.resource_usage where task_id = $1 and kind = 'workspace_seconds'",
        [t.id]
      )
    ).toEqual({ n: 1 })

    // A failed resume leaves the earlier sandbox alone and the workspace paused
    provider.unhealthy = false
    const tb = await task(user, "w06b")
    const first = new TaskWorkspace(provider, tb, SETTINGS)
    await first.open({})
    await first.close("shutdown")
    for (const knob of ["unhealthy", "resumeFails"] as const) {
      provider[knob] = true
      provider.calls = []
      const tc = { ...(await task(user, "w06b")), threadId: tb.threadId }
      const again = new TaskWorkspace(provider, tc, SETTINGS, { healthMs: 500 })
      await expect(again.client()).rejects.toThrow(
        "The workspace couldn't be started for this task."
      )
      expect(provider.ops()).toEqual(["resume"])
      expect(
        await one("select status from kriya.workspaces where thread_id = $1", [
          tb.threadId,
        ])
      ).toEqual({ status: "paused" })
      expect(
        await one("select status from kriya.workspace_sessions where task_id = $1", [
          tc.id,
        ])
      ).toEqual({ status: "failed" })
      provider[knob] = false
    }
  })

  it("CT-WS-07: a lost sandbox is rebuilt: next generation, import at base, restore", async () => {
    const { store } = memoryStore()
    const { source, calls } = fixtureSource()
    const t = await task(user, "w07")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store, source })
    expect(await ws.open({ repo: "owner/calc" })).toMatchObject({
      repo: "owner/calc",
      baseSha: BASE_SHA,
      status: "running",
      restored: false,
    })
    expect(calls).toEqual([{ repo: "owner/calc", ref: null }])
    const client = await ws.client()
    await client.read({ path: "src/math.js" })
    await client.edit({
      path: "src/math.js",
      oldText: "multiply(a, b) {\n  return a + b",
      newText: "multiply(a, b) {\n  return a * b",
    })
    await ws.close(null)
    await provider.forget()

    const t2 = { ...(await task(user, "w07")), threadId: t.threadId }
    const next = new TaskWorkspace(provider, t2, SETTINGS, { store, source })
    expect(await next.open({ repo: "owner/calc" })).toMatchObject({
      repo: "owner/calc",
      baseSha: BASE_SHA,
      restored: true,
    })
    expect(calls.at(-1)).toEqual({ repo: "owner/calc", ref: BASE_SHA })
    // Generation 1 was the first task's sandbox; the rebuild is generation 2
    expect(
      provider.calls.filter((c) => c.op === "create").map((c) => c.generation)
    ).toEqual([1, 2])
    expect(await textOf(await next.client(), "src/math.js")).toContain("a * b")
    await expect(next.open({ repo: "owner/other" })).rejects.toThrow(/close it first/)
    await next.close(null)
  })

  it("CT-WS-08: a workspace belongs to one thread of one person", async () => {
    const tA = await task(user, "w08a")
    const a = new TaskWorkspace(provider, tA, SETTINGS)
    await a.open({})
    await a.close("shutdown")

    const tB = await task(user, "w08b")
    const b = new TaskWorkspace(provider, tB, SETTINGS)
    expect(await b.describe()).toBeNull()
    await b.open({})
    await b.close("shutdown")
    const rows = await pg.query<{ thread_id: string }>(
      "select thread_id from kriya.workspaces where user_id = $1 and thread_id in ($2, $3) order by thread_id",
      [user, tA.threadId, tB.threadId]
    )
    expect(rows.rows.map((r) => r.thread_id)).toEqual([tA.threadId, tB.threadId])

    // Another person, even naming the same thread id, sees nothing
    const tO = await task(other, "w08o")
    const forged = new TaskWorkspace(provider, { ...tO, threadId: tA.threadId }, SETTINGS)
    expect(await forged.describe()).toBeNull()
    expect(await new TaskWorkspace(provider, tO, SETTINGS).describe()).toBeNull()
  })

  it("CT-WS-09: the runner token derives from the workspace and generation", async () => {
    const id = randomUUID()
    const token = runnerToken(id, 1)
    expect(token).toBe(runnerToken(id, 1))
    expect(token).not.toBe(runnerToken(id, 2))
    expect(token).not.toBe(runnerToken(randomUUID(), 1))
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(token).not.toContain(process.env.KRIYA_WORKSPACE_SECRET)

    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const runner = await createRunner({
      root: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-token-")),
      token,
      generation: 1,
      home: os.tmpdir(),
      path: process.env.PATH ?? "/usr/bin:/bin",
    })
    try {
      await new RunnerClient(runner.url, token).list({})
      process.env.KRIYA_WORKSPACE_SECRET = "r".repeat(43)
      const rotated = runnerToken(id, 1)
      expect(rotated).not.toBe(token)
      const refused = await new RunnerClient(runner.url, rotated).list({}).catch((e) => e)
      expect(refused).toBeInstanceOf(RunnerRequestError)
      expect(refused.status).toBe(401)
    } finally {
      process.env.KRIYA_WORKSPACE_SECRET = "s".repeat(43)
      await runner.close()
    }
    delete process.env.KRIYA_WORKSPACE_SECRET
    expect(() => runnerToken(id, 1)).toThrow(/KRIYA_WORKSPACE_SECRET/)
    process.env.KRIYA_WORKSPACE_SECRET = "s".repeat(43)
  })
})
