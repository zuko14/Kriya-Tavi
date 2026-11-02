import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { workspaceJanitor, type JanitorSettings } from "@/lib/cloud/janitor"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"
import { runnerToken } from "@/lib/cloud/token"
import { BUCKET, type FileStore } from "@/lib/files"

import { createUser } from "../db/harness"
import { cloudDb } from "./db"
import { FakeProvider, memoryStore } from "./fake-provider"

// The workspace janitor (TOOLS_AND_CONTRACTS §6, TEST_STRATEGY CT-JAN-*):
// orphans, close requests, idle sandboxes, retention, provider reconcile
// and deleted accounts, on a real Postgres with the fake provider.

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
  // Supabase keeps object names in storage.objects; PGlite needs the table
  await db.pg.exec(
    "create schema if not exists storage; create table if not exists storage.objects (bucket_id text not null, name text not null)"
  )
})

beforeEach(() => {
  provider = new FakeProvider()
})

afterEach(async () => {
  await provider.closeAll()
})

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows[0]

const row = (threadId: string) =>
  one<{
    id: string
    status: string
    provider_ref: string | null
    checkpoint_path: string | null
    checkpoint_seq: number
    closed_at: Date | null
  }>("select * from kriya.workspaces where thread_id = $1", [threadId])

// Storage that also lists its objects in storage.objects, as Supabase does
function listedStore() {
  const { store, objects } = memoryStore()
  const listed: FileStore = {
    ...store,
    write: async (p, bytes, mime) => {
      await store.write(p, bytes, mime)
      await db.pg.query("insert into storage.objects (bucket_id, name) values ($1, $2)", [
        BUCKET,
        p,
      ])
    },
    remove: async (paths) => {
      await store.remove(paths)
      await db.pg.query("delete from storage.objects where name = any($1)", [paths])
    },
  }
  return { store: listed, objects }
}

// A workspace with one changed file, left as the given kind of end
async function workspaceWith(tag: string, store: FileStore, userId = db.user) {
  const t = await db.task(tag, userId)
  const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
  await ws.open({})
  await (await ws.client()).write({ path: "work.txt", content: `${tag}\n` })
  return { t, ws }
}

describe.skipIf(!hasGit)("workspace janitor", () => {
  it("CT-JAN-01: a stale session is checkpointed, paused, closed as orphan, metered to its last heartbeat", async () => {
    const { store, objects } = memoryStore()
    const { t } = await workspaceWith("jan01", store)
    // The worker died: no close; the heartbeat stopped 10 minutes ago
    await db.pg.query(
      `update kriya.workspace_sessions
       set opened_at = now() - interval '1 hour', heartbeat_at = now() - interval '10 minutes'
       where task_id = $1`,
      [t.id]
    )
    const result = await workspaceJanitor({
      provider,
      store,
      settings: JANITOR,
      reconcile: false,
    })
    expect(result).toMatchObject({ orphans: 1 })
    const r = await row(t.threadId)
    expect(r).toMatchObject({ status: "paused", checkpoint_seq: 1 })
    expect(objects.has(r.checkpoint_path!)).toBe(true)
    expect(provider.ops().at(-1)).toBe("pause")
    const session = await one<{ status: string; close_reason: string; seconds: number }>(
      "select status, close_reason, seconds from kriya.workspace_sessions where task_id = $1",
      [t.id]
    )
    expect(session).toMatchObject({ status: "closed", close_reason: "orphan" })
    expect(Math.abs(session.seconds - 3000)).toBeLessThanOrEqual(2)
    expect(
      await one(
        "select quantity from kriya.resource_usage where task_id = $1 and kind = 'workspace_seconds'",
        [t.id]
      )
    ).toEqual({ quantity: session.seconds })

    // A fresh heartbeat is left alone
    const { t: live, ws } = await workspaceWith("jan01b", store)
    await workspaceJanitor({ provider, store, settings: JANITOR, reconcile: false })
    expect((await row(live.threadId)).status).toBe("running")
    await ws.close(null)
  })

  it("CT-JAN-02: idle past pausedHours → destroyed with a checkpoint; unused past retentionDays or asked to close → closed, objects deleted", async () => {
    const { store, objects } = memoryStore()
    const idle = await workspaceWith("jan02a", store)
    await idle.ws.close(null)
    await db.pg.query(
      "update kriya.workspaces set last_active_at = now() - interval '25 hours' where thread_id = $1",
      [idle.t.threadId]
    )
    const old = await workspaceWith("jan02b", store)
    await old.ws.close(null)
    await db.pg.query(
      "update kriya.workspaces set last_active_at = now() - interval '15 days' where thread_id = $1",
      [old.t.threadId]
    )
    const asked = await workspaceWith("jan02c", store)
    await asked.ws.close(null)
    await db.pg.query(
      "update kriya.workspaces set close_requested_at = now() where thread_id = $1",
      [asked.t.threadId]
    )
    // Asked to close while a task is using it: waits for the task
    const busy = await workspaceWith("jan02d", store)
    await db.pg.query(
      "update kriya.workspaces set close_requested_at = now() where thread_id = $1",
      [busy.t.threadId]
    )

    const result = await workspaceJanitor({
      provider,
      store,
      settings: JANITOR,
      reconcile: false,
    })
    expect(result).toMatchObject({ closed: 2, destroyed: 1 })

    const a = await row(idle.t.threadId)
    expect(a).toMatchObject({ status: "paused", provider_ref: null, checkpoint_seq: 1 })
    expect(objects.has(a.checkpoint_path!)).toBe(true)
    for (const threadId of [old.t.threadId, asked.t.threadId]) {
      const r = await row(threadId)
      expect(r).toMatchObject({
        status: "closed",
        provider_ref: null,
        checkpoint_path: null,
      })
      expect(r.closed_at).not.toBeNull()
      expect([...objects.keys()].some((k) => k.includes(r.id))).toBe(false)
    }
    expect((await row(busy.t.threadId)).status).toBe("running")
    expect(provider.sandboxes.size).toBe(1)

    await busy.ws.close(null)
    await workspaceJanitor({ provider, store, settings: JANITOR, reconcile: false })
    expect((await row(busy.t.threadId)).status).toBe("closed")
    expect(provider.sandboxes.size).toBe(0)
  })

  it("CT-JAN-03: reconcile destroys provider sandboxes with no open row", async () => {
    const { store } = memoryStore()
    const kept = await workspaceWith("jan03", store)
    await kept.ws.close(null)
    const stray = await provider.create({
      workspaceId: randomUUID(),
      userId: db.user,
      generation: 1,
      image: "kriya-runner:test",
      size: "2c-4g",
      network: "registries",
      runnerToken: runnerToken(randomUUID(), 1),
      limits: {},
      timeoutSeconds: 60,
    })
    // A sandbox of a workspace that is still starting is someone's start
    const starting = await db.task("jan03b")
    const { rows } = await db.pg.query<{ id: string }>(
      `insert into kriya.workspaces (user_id, thread_id, provider, image, size, status)
       values ($1, $2, 'local', 'kriya-runner:test', '2c-4g', 'starting') returning id`,
      [db.user, starting.threadId]
    )
    const midStart = await provider.create({
      workspaceId: rows[0].id,
      userId: db.user,
      generation: 1,
      image: "kriya-runner:test",
      size: "2c-4g",
      network: "registries",
      runnerToken: runnerToken(rows[0].id, 1),
      limits: {},
      timeoutSeconds: 60,
    })

    const result = await workspaceJanitor({
      provider,
      store,
      settings: JANITOR,
      reconcile: true,
    })
    expect(result).toMatchObject({ reconciled: 1 })
    expect(provider.calls.filter((c) => c.op === "destroy").map((c) => c.ref)).toEqual([
      stray.ref,
    ])
    expect(provider.sandboxes.has(midStart.ref)).toBe(true)
    expect(provider.sandboxes.has((await row(kept.t.threadId)).provider_ref!)).toBe(true)
    // That start failed after all (CT-JAN-05 expects nothing left open)
    await db.pg.query("update kriya.workspaces set status = 'failed' where id = $1", [
      rows[0].id,
    ])
  })

  it("CT-JAN-04: an account deleted → its sandboxes destroyed and its storage prefix deleted", async () => {
    const { store, objects } = listedStore()
    const gone = await createUser(db.pg)
    const theirs = await workspaceWith("jan04a", store, gone)
    await theirs.ws.close(null)
    const mine = await workspaceWith("jan04b", store)
    await mine.ws.close(null)
    const ref = (await row(theirs.t.threadId)).provider_ref!
    const mineRef = (await row(mine.t.threadId)).provider_ref!

    await db.pg.query("delete from auth.users where id = $1", [gone])
    const result = await workspaceJanitor({
      provider,
      store,
      settings: JANITOR,
      reconcile: true,
    })
    expect(result).toMatchObject({ reconciled: 1, swept: 1 })
    expect(provider.sandboxes.has(ref)).toBe(false)
    expect(provider.sandboxes.has(mineRef)).toBe(true)
    expect([...objects.keys()].some((k) => k.startsWith(`workspaces/${gone}/`))).toBe(
      false
    )
    expect([...objects.keys()].some((k) => k.startsWith(`workspaces/${db.user}/`))).toBe(
      true
    )
  })

  it("CT-JAN-05: with the switch off it still pauses running workspaces; with nothing open it does nothing", async () => {
    const { store } = memoryStore()
    const off = { ...JANITOR, enabled: false }
    const { t } = await workspaceWith("jan05", store)
    await db.pg.query(
      "update kriya.workspace_sessions set heartbeat_at = now() - interval '10 minutes' where task_id = $1",
      [t.id]
    )
    await workspaceJanitor({ provider, store, settings: off, reconcile: false })
    expect((await row(t.threadId)).status).toBe("paused")
    expect(provider.ops().at(-1)).toBe("pause")

    // Every workspace closed: no provider call at all
    await db.pg.query(
      "update kriya.workspaces set close_requested_at = now() where status <> 'closed'"
    )
    await workspaceJanitor({ provider, store, settings: off, reconcile: false })
    expect(
      await one(
        "select count(*)::int as n from kriya.workspaces where status not in ('closed', 'new')"
      )
    ).toEqual({ n: 0 })
    const calls = provider.calls.length
    expect(
      await workspaceJanitor({ provider, store, settings: off, reconcile: true })
    ).toBeNull()
    expect(provider.calls.length).toBe(calls)
  })
})
