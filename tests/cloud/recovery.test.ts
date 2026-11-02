import { spawnSync } from "node:child_process"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { RunnerClient } from "@/lib/cloud/client"
import { workspaceJanitor, type JanitorSettings } from "@/lib/cloud/janitor"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"
import { runnerToken } from "@/lib/cloud/token"
import { createWorkspaceTools } from "@/lib/cloud/tools"
import type { FileStore } from "@/lib/files"

import { cloudDb } from "./db"
import { FakeProvider, FIXTURE, memoryStore, textOf } from "./fake-provider"
import { packDirectory } from "./tar"
import {
  connectGithub,
  importFixtures,
  publishFixtures,
  serveGithub,
} from "./github-fixtures"

// CR-5 (SECURITY_AND_THREATS §6, OPERATIONS_RUNBOOK §9): recovery drills on
// a real Postgres (PGlite) with the real runner in-process behind the fake
// provider. A worker killed mid-command, a sandbox destroyed mid-task, and
// a storage outage right before a publish: no false success, no duplicate
// side effect, no session or runner token outliving its sandbox, and the
// workspace row always in a state the next task can use.

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

const JANITOR: JanitorSettings = {
  enabled: true,
  orphanSeconds: 120,
  pausedHours: 24,
  retentionDays: 14,
  cloud: SETTINGS,
}

let db: Awaited<ReturnType<typeof cloudDb>>
let provider: FakeProvider

beforeAll(async () => {
  db = await cloudDb()
  await connectGithub(db.user)
})
beforeEach(() => {
  provider = new FakeProvider()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await provider.closeAll()
})

type WsRow = {
  id: string
  status: string
  generation: number
  provider_ref: string | null
  checkpoint_path: string | null
  checkpoint_seq: number
  checkpoint_failed_at: Date | null
}
const row = async (threadId: string) =>
  (
    await db.pg.query<WsRow>(
      "select id, status, generation, provider_ref, checkpoint_path, checkpoint_seq, checkpoint_failed_at from kriya.workspaces where thread_id = $1 and status <> 'closed'",
      [threadId]
    )
  ).rows[0]
const sessions = async (workspaceId: string) =>
  (
    await db.pg.query<{ status: string; close_reason: string | null }>(
      "select status, close_reason from kriya.workspace_sessions where workspace_id = $1 order by opened_at",
      [workspaceId]
    )
  ).rows
const meteredSeconds = async (userId: string) =>
  (
    await db.pg.query<{ n: number }>(
      "select count(*)::int as n from kriya.resource_usage where user_id = $1 and kind = 'workspace_seconds'",
      [userId]
    )
  ).rows[0].n

const exists = (client: RunnerClient, path: string) =>
  client.read({ path }).then(
    () => true,
    () => false
  )

type Tool = { execute: (input: unknown, options: unknown) => unknown }
async function call(
  tool: unknown,
  input: unknown,
  signal = new AbortController().signal
) {
  const result = (tool as Tool).execute(input, {
    toolCallId: "c1",
    messages: [],
    abortSignal: signal,
  })
  if (
    result &&
    typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  ) {
    let last: unknown
    for await (const item of result as AsyncIterable<unknown>) last = item
    return last as Record<string, unknown>
  }
  return (await result) as Record<string, unknown>
}

describe.skipIf(!hasGit)(
  "CR-5 drill 1: the worker dies in the middle of a command",
  () => {
    it("the command stops with its caller, the janitor closes the orphan once, and the retry resumes the same sandbox", async () => {
      const { store, objects } = memoryStore()
      const t = await db.task("rec01")
      const dead = new TaskWorkspace(provider, t, SETTINGS, { store })
      await dead.open({})
      const client = await dead.client()
      await client.write({ path: "saved.txt", content: "checkpointed\n" })
      expect(await dead.checkpointNow()).toBe(true)
      await client.write({ path: "unsaved.txt", content: "after the checkpoint\n" })

      // The worker process dies mid-command: its connection to the runner
      // drops and nothing of it runs again (no close, no heartbeat, no pause)
      const killed = new AbortController()
      const running = client
        .exec(
          { command: "sleep 2; echo late > late.txt", timeoutSeconds: 30 },
          { signal: killed.signal }
        )
        .catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 300))
      killed.abort()
      expect(await running).toBeInstanceOf(Error)
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(await exists(client, "late.txt")).toBe(false)

      let r = await row(t.threadId)
      expect(r.status).toBe("running")
      expect(await sessions(r.id)).toEqual([{ status: "open", close_reason: null }])

      // While the dead worker's session is open, no other attempt may open one
      const early = new TaskWorkspace(provider, t, SETTINGS, { store })
      await expect(early.client()).rejects.toThrow(/couldn't be started|in use/)

      // Its heartbeat goes stale; the janitor checkpoints, pauses, and meters
      // that session once, up to its last heartbeat
      await db.pg.query(
        "update kriya.workspace_sessions set heartbeat_at = now() - interval '10 minutes' where workspace_id = $1 and status = 'open'",
        [r.id]
      )
      const swept = await workspaceJanitor({
        provider,
        store,
        settings: JANITOR,
        reconcile: false,
      })
      expect(swept?.orphans).toBe(1)
      r = await row(t.threadId)
      expect(r.status).toBe("paused")
      expect(r.checkpoint_seq).toBe(2)
      expect(r.checkpoint_failed_at).toBeNull()
      expect((await sessions(r.id)).map((s) => s.close_reason)).toEqual(["orphan"])
      const metered = await meteredSeconds(t.userId)
      // A second sweep finds nothing and meters nothing again
      expect(
        (await workspaceJanitor({ provider, store, settings: JANITOR, reconcile: false }))
          ?.orphans
      ).toBe(0)
      expect(await meteredSeconds(t.userId)).toBe(metered)

      // The retried attempt (same task) resumes the same sandbox: same
      // generation, same token, every file there, nothing duplicated
      const retry = new TaskWorkspace(provider, t, SETTINGS, { store })
      const again = await retry.client()
      expect(await textOf(again, "saved.txt")).toBe("checkpointed\n")
      expect(await textOf(again, "unsaved.txt")).toBe("after the checkpoint\n")
      expect(await exists(again, "late.txt")).toBe(false)
      expect((await row(t.threadId)).generation).toBe(r.generation)
      expect(provider.ops().filter((op) => op === "create")).toHaveLength(1)
      await retry.close(null)
      expect(
        [...objects.keys()].every((key) =>
          key.startsWith(`workspaces/${t.userId}/${r.id}/`)
        )
      ).toBe(true)
      expect((await sessions(r.id)).filter((s) => s.status === "open")).toEqual([])
    })

    it("if the sandbox died with the worker, the retry rebuilds at a new generation and the old token opens nothing", async () => {
      const { store } = memoryStore()
      const t = await db.task("rec01b")
      const dead = new TaskWorkspace(provider, t, SETTINGS, { store })
      await dead.open({})
      await (await dead.client()).write({ path: "saved.txt", content: "checkpointed\n" })
      expect(await dead.checkpointNow()).toBe(true)
      const before = await row(t.threadId)
      await db.pg.query(
        "update kriya.workspace_sessions set heartbeat_at = now() - interval '10 minutes' where workspace_id = $1 and status = 'open'",
        [before.id]
      )
      await provider.forget()
      await workspaceJanitor({ provider, store, settings: JANITOR, reconcile: false })

      const retry = new TaskWorkspace(provider, t, SETTINGS, { store })
      const rebuilt = await retry.client()
      expect(await textOf(rebuilt, "saved.txt")).toBe("checkpointed\n")
      const after = await row(t.threadId)
      expect(after.generation).toBe(before.generation + 1)
      // The previous generation's token is refused by the new runner
      const sandbox = provider.sandboxes.get(after.provider_ref!)!
      const stale = new RunnerClient(
        sandbox.runner.url,
        runnerToken(after.id, before.generation)
      )
      await expect(stale.read({ path: "saved.txt" })).rejects.toMatchObject({
        status: 401,
      })
      await retry.close(null)
    })
  }
)

describe.skipIf(!hasGit)(
  "CR-5 drill 2: the sandbox is destroyed in the middle of a task",
  () => {
    it("the command reports an error, the end marks the failed checkpoint, and the next task restores the last saved state", async () => {
      const { store } = memoryStore()
      const t = await db.task("rec02")
      const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
      const tools = createWorkspaceTools(ws, { repos: false })
      expect(await call(tools.workspace_open, {})).toMatchObject({ status: "running" })
      await call(tools.workspace_write, { path: "saved.txt", content: "checkpointed\n" })
      expect(await ws.checkpointNow()).toBe(true)
      await call(tools.workspace_write, { path: "lost.txt", content: "never saved\n" })

      // The provider destroys the sandbox while a command runs
      const run = call(tools.workspace_run, { command: "sleep 5; echo done" })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await provider.forget()
      const result = await run
      expect(result).toHaveProperty("error")
      expect(result).not.toHaveProperty("exitCode")
      // Later calls fail too; none of them reports success
      expect(await call(tools.workspace_read, { path: "saved.txt" })).toHaveProperty(
        "error"
      )

      await ws.close(null)
      let r = await row(t.threadId)
      expect(r.status).toBe("paused")
      expect(r.checkpoint_failed_at).not.toBeNull()
      expect(r.checkpoint_seq).toBe(1)
      expect((await sessions(r.id)).map((s) => s.status)).toEqual(["closed"])

      // The janitor finds the provider let it go and forgets the reference
      await db.pg.query(
        "update kriya.workspaces set checkpoint_failed_at = now() - interval '1 hour' where id = $1",
        [r.id]
      )
      await workspaceJanitor({ provider, store, settings: JANITOR, reconcile: false })
      r = await row(t.threadId)
      expect(r.provider_ref).toBeNull()

      // The next task: rebuilt from the last checkpoint; what came after it is gone (CS-14)
      const next = new TaskWorkspace(provider, await db.task("rec02"), SETTINGS, {
        store,
      })
      const restored = await next.client()
      expect(await textOf(restored, "saved.txt")).toBe("checkpointed\n")
      expect(await exists(restored, "lost.txt")).toBe(false)
      expect((await next.describe())?.restored).toBe(true)
      await next.close(null)
    })
  }
)

describe.skipIf(!hasGit)("CR-5 drill 3: storage fails right before a publish", () => {
  it("nothing reaches GitHub, the workspace is marked and kept, and the same approved change publishes once when storage is back", async () => {
    const REPO = "owner/calc"
    const { store, objects } = memoryStore()
    let down = true
    const flaky: FileStore = {
      ...store,
      write: async (path, bytes, mime) => {
        if (down) throw new Error("storage: service unavailable")
        return store.write(path, bytes, mime)
      },
    }
    const t = await db.task("rec03")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store: flaky })
    const tools = createWorkspaceTools(ws, { repos: true, publish: true })
    serveGithub(importFixtures(REPO, packDirectory(FIXTURE)))
    expect(await call(tools.workspace_open, { repo: REPO })).toMatchObject({
      status: "running",
    })
    vi.unstubAllGlobals()
    await call(tools.workspace_read, { path: "src/math.js" })
    await call(tools.workspace_edit, {
      path: "src/math.js",
      oldText: "multiply(a, b) {\n  return a + b",
      newText: "multiply(a, b) {\n  return a * b",
    })
    const { changeSetId } = (await call(tools.workspace_changes, {})) as {
      changeSetId: string
    }
    const input = {
      repo: REPO,
      changeSetId,
      branch: "kriya/fix-multiply",
      title: "Fix multiply",
      body: "multiply added instead of multiplying.",
    }

    const first = serveGithub(publishFixtures(REPO, "kriya/fix-multiply"))
    const refused = await call(tools.workspace_publish, input)
    expect(refused.error).toMatch(
      /couldn't be saved before publishing, so nothing was sent to GitHub/
    )
    expect(first.calls).toEqual([])
    let r = await row(t.threadId)
    expect(r).toMatchObject({
      status: "running",
      checkpoint_seq: 0,
      checkpoint_path: null,
    })
    expect(r.checkpoint_failed_at).not.toBeNull()
    expect(objects.size).toBe(0)
    // The tree is as approved: the same change set is still on offer
    expect(
      ((await call(tools.workspace_changes, {})) as { changeSetId: string }).changeSetId
    ).toBe(changeSetId)
    vi.unstubAllGlobals()

    down = false
    const second = serveGithub(publishFixtures(REPO, "kriya/fix-multiply"))
    expect(await call(tools.workspace_publish, input)).toMatchObject({
      number: 12,
      branch: "kriya/fix-multiply",
    })
    expect(second.left()).toBe(0)
    expect(
      second.calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls"))
    ).toHaveLength(1)
    r = await row(t.threadId)
    expect(r.checkpoint_failed_at).toBeNull()
    expect(r.checkpoint_seq).toBe(1)
    expect(objects.has(r.checkpoint_path!)).toBe(true)
    vi.unstubAllGlobals()
    await ws.close(null)
  })
})

describe.skipIf(!hasGit)("Runbook §3 drill: rotating KRIYA_WORKSPACE_SECRET", () => {
  it("a paused sandbox from before the rotation is replaced by a restore from its checkpoint; nothing fails with 401", async () => {
    const { store } = memoryStore()
    const t = await db.task("rot01")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
    await ws.open({})
    await (await ws.client()).write({ path: "kept.txt", content: "before rotation\n" })
    await ws.close(null)
    const before = await row(t.threadId)
    expect(before).toMatchObject({ status: "paused", checkpoint_seq: 1 })

    const old = process.env.KRIYA_WORKSPACE_SECRET
    process.env.KRIYA_WORKSPACE_SECRET = "r".repeat(43)
    try {
      const next = new TaskWorkspace(provider, await db.task("rot01"), SETTINGS, {
        store,
      })
      const client = await next.client()
      expect(await textOf(client, "kept.txt")).toBe("before rotation\n")
      expect((await row(t.threadId)).generation).toBe(before.generation + 1)
      await next.close(null)
    } finally {
      process.env.KRIYA_WORKSPACE_SECRET = old
    }
  })
})

describe.skipIf(!hasGit)("Runbook §3 drill: the janitor after a rotation", () => {
  it("an idle sandbox from before the rotation is let go, not retried as a failed checkpoint, and reconciled away", async () => {
    const { store } = memoryStore()
    const t = await db.task("rot02")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
    await ws.open({})
    await (await ws.client()).write({ path: "kept.txt", content: "before rotation\n" })
    await ws.close(null)
    const before = await row(t.threadId)

    const old = process.env.KRIYA_WORKSPACE_SECRET
    process.env.KRIYA_WORKSPACE_SECRET = "r".repeat(43)
    try {
      await db.pg.query(
        "update kriya.workspaces set last_active_at = now() - interval '25 hours' where id = $1",
        [before.id]
      )
      await workspaceJanitor({ provider, store, settings: JANITOR, reconcile: true })
      const after = await row(t.threadId)
      expect(after).toMatchObject({
        status: "paused",
        provider_ref: null,
        checkpoint_seq: 1,
      })
      expect(after.checkpoint_failed_at).toBeNull()
      // The sandbox nobody owns any more is destroyed by the reconcile
      expect(provider.ops()).toContain("destroy")
      expect(provider.sandboxes.size).toBe(0)

      const next = new TaskWorkspace(provider, await db.task("rot02"), SETTINGS, {
        store,
      })
      expect(await textOf(await next.client(), "kept.txt")).toBe("before rotation\n")
      await next.close(null)
    } finally {
      process.env.KRIYA_WORKSPACE_SECRET = old
    }
  })
})
