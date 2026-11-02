import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { saveCheckpoint } from "@/lib/cloud/checkpoint"
import type { RunnerClient } from "@/lib/cloud/client"
import { workspaceJanitor, type JanitorSettings } from "@/lib/cloud/janitor"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"
import type { FileStore } from "@/lib/files"

import { cloudDb } from "./db"
import { FakeProvider, memoryStore, textOf } from "./fake-provider"

// Checkpoints (CD-13, TEST_STRATEGY CT-CKP-*): the fake provider's sandboxes
// are the real runner in-process, storage is in memory.

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
})

beforeEach(() => {
  provider = new FakeProvider()
})

afterEach(async () => {
  await provider.closeAll()
})

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows[0]

type WsRow = {
  id: string
  status: string
  provider_ref: string | null
  checkpoint_path: string | null
  checkpoint_sha256: string | null
  checkpoint_bytes: string | null
  checkpoint_seq: number
  checkpoint_failed_at: Date | null
}
const row = (threadId: string) =>
  one<WsRow>("select * from kriya.workspaces where thread_id = $1", [threadId])

// A task in the same thread as an earlier one
const again = async (tag: string) => db.task(tag)

describe.skipIf(!hasGit)("checkpoints", () => {
  it("CT-CKP-01: path, sha256 and size stored; sequence increments; older than the previous deleted", async () => {
    const { store, objects } = memoryStore()
    let threadId = ""
    for (const n of [1, 2, 3]) {
      const t = await again("ckp01")
      threadId = t.threadId
      const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
      if (n === 1) await ws.open({})
      const client = await ws.client()
      await client.write({ path: `f${n}.txt`, content: `${n}\n` })
      await ws.close(null)
      const r = await row(threadId)
      expect(r.checkpoint_seq).toBe(n)
      expect(r.checkpoint_path).toBe(`workspaces/${db.user}/${r.id}/1-${n}.patch`)
      const patch = objects.get(r.checkpoint_path!)!
      expect(r.checkpoint_sha256).toBe(createHash("sha256").update(patch).digest("hex"))
      expect(Number(r.checkpoint_bytes)).toBe(patch.length)
    }
    const r = await row(threadId)
    expect([...objects.keys()].sort()).toEqual([
      `workspaces/${db.user}/${r.id}/1-2.patch`,
      `workspaces/${db.user}/${r.id}/1-3.patch`,
    ])
    const usage = await one<{ n: number }>(
      "select count(*)::int as n from kriya.resource_usage where kind = 'workspace_storage_bytes' and request_key like $1",
      [`workspace-ckpt:${r.id}:%`]
    )
    expect(usage.n).toBe(3)
  })

  it("CT-CKP-02: restore after the janitor destroyed the sandbox reproduces the tree", async () => {
    const { store } = memoryStore()
    const t = await again("ckp02")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store })
    await ws.open({})
    const client = await ws.client()
    await client.write({ path: "keep.txt", content: "kept\n" })
    await client.write({
      path: "bin.dat",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      encoding: "base64",
    })
    await client.write({ path: "gone.txt", content: "x\n" })
    await ws.close(null)
    const t2 = await again("ckp02")
    const ws2 = new TaskWorkspace(provider, t2, SETTINGS, { store })
    await (await ws2.client()).exec({ command: "rm gone.txt", timeoutSeconds: 10 })
    await ws2.close(null)

    // Paused past cloud.pausedHours: destroyed after a checkpoint
    await db.pg.query(
      "update kriya.workspaces set last_active_at = now() - interval '25 hours' where thread_id = $1",
      [t.threadId]
    )
    await workspaceJanitor({ provider, store, settings: JANITOR, reconcile: false })
    expect(provider.ops()).toContain("destroy")
    expect(provider.sandboxes.size).toBe(0)
    expect((await row(t.threadId)).provider_ref).toBeNull()

    const t3 = await again("ckp02")
    const ws3 = new TaskWorkspace(provider, t3, SETTINGS, { store })
    const restored = await ws3.client()
    expect(await textOf(restored, "keep.txt")).toBe("kept\n")
    const bin = await restored.read({ path: "bin.dat", encoding: "base64" })
    expect("base64" in bin && Buffer.from(bin.base64, "base64")).toEqual(
      Buffer.from([0, 1, 2, 255])
    )
    await expect(restored.read({ path: "gone.txt" })).rejects.toThrow()
    expect((await ws3.describe())?.restored).toBe(true)
    await ws3.close(null)
  })

  it("CT-CKP-03: a failed upload sets checkpoint_failed_at; the janitor never destroys while it is set", async () => {
    const { store, objects } = memoryStore()
    let failing = true
    const flaky: FileStore = {
      ...store,
      write: async (p, bytes, mime) => {
        if (failing) throw new Error("storage: upload failed")
        return store.write(p, bytes, mime)
      },
    }
    const t = await again("ckp03")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store: flaky })
    await ws.open({})
    await (await ws.client()).write({ path: "work.txt", content: "unsaved\n" })
    await ws.close(null)
    let r = await row(t.threadId)
    expect(r.status).toBe("paused")
    expect(r.checkpoint_failed_at).not.toBeNull()
    expect(r.checkpoint_path).toBeNull()

    await db.pg.query(
      "update kriya.workspaces set last_active_at = now() - interval '25 hours', checkpoint_failed_at = now() - interval '1 hour' where id = $1",
      [r.id]
    )
    await workspaceJanitor({
      provider,
      store: flaky,
      settings: JANITOR,
      reconcile: false,
    })
    expect(provider.ops()).not.toContain("destroy")
    expect(provider.sandboxes.size).toBe(1)
    r = await row(t.threadId)
    expect(r.provider_ref).not.toBeNull()
    expect(r.checkpoint_failed_at).not.toBeNull()

    // Storage is back: the retry saves, clears the mark, then destroys
    failing = false
    await db.pg.query(
      "update kriya.workspaces set checkpoint_failed_at = now() - interval '1 hour' where id = $1",
      [r.id]
    )
    await workspaceJanitor({
      provider,
      store: flaky,
      settings: JANITOR,
      reconcile: false,
    })
    r = await row(t.threadId)
    expect(r.checkpoint_failed_at).toBeNull()
    expect(r.checkpoint_seq).toBe(1)
    expect(objects.has(r.checkpoint_path!)).toBe(true)
    expect(r.provider_ref).toBeNull()
    expect(provider.ops()).toContain("destroy")
  })

  it("CT-CKP-04: objects only under workspaces/<user_id>/; no signed URL; a checkpoint right before publish", async () => {
    const { store, objects } = memoryStore()
    const signedUrl = vi.fn(store.signedUrl)
    const uploadUrl = vi.fn(store.uploadUrl)
    const watched: FileStore = { ...store, signedUrl, uploadUrl }
    const t = await again("ckp04")
    const ws = new TaskWorkspace(provider, t, SETTINGS, { store: watched })
    await ws.open({})
    await (await ws.client()).write({ path: "a.txt", content: "a\n" })
    await ws.checkpointNow()
    let r = await row(t.threadId)
    expect(r).toMatchObject({ status: "running", checkpoint_seq: 1 })
    // Nothing changed since: the end adds no checkpoint
    await ws.close(null)
    r = await row(t.threadId)
    expect(r.checkpoint_seq).toBe(1)
    await db.pg.query(
      "update kriya.workspaces set last_active_at = now() - interval '25 hours' where id = $1",
      [r.id]
    )
    await workspaceJanitor({
      provider,
      store: watched,
      settings: JANITOR,
      reconcile: false,
    })
    expect(objects.size).toBe(1)
    for (const key of objects.keys())
      expect(key.startsWith(`workspaces/${db.user}/`)).toBe(true)
    expect(signedUrl).not.toHaveBeenCalled()
    expect(uploadUrl).not.toHaveBeenCalled()
  })
})

// Re-audit 2026-11-02: the runner's x-kriya-sha256 header is checked
// against the bytes before anything is stored, so a damaged or truncated
// patch is a failed checkpoint (the sandbox is kept), never a stored one
// that a later restore can't use
describe("CT-CKP-05: the checkpoint's own digest", () => {
  it("a patch whose bytes don't match the runner's sha256 is not stored", async () => {
    const { store, objects } = memoryStore()
    const patch = Buffer.from("diff --git a/x b/x\n")
    const client = (sha256: string) =>
      ({
        checkpoint: async () => ({
          patch,
          sha256,
          changes: { files: 1, added: 1, removed: 0 },
        }),
      }) as unknown as RunnerClient
    const at = {
      userId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      generation: 1,
      seq: 0,
      sha256: null,
      taskId: null,
    }
    const bad = await saveCheckpoint(store, client("0".repeat(64)), at)
    expect(bad.checkpointFailedAt).toBeInstanceOf(Date)
    expect(bad.checkpointPath).toBeUndefined()
    expect(objects.size).toBe(0)
  })
})
