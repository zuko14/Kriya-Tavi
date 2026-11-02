import { createHash, randomUUID } from "node:crypto"

import { and, eq } from "drizzle-orm"
import type { z } from "zod"

import { privileged, withUser } from "@/db"
import { connections, resourceUsage, threads, workspaces } from "@/db/schema"
import { enqueueTurn, TurnError } from "@/lib/agent/queue"
import { appUrl, type DeviceUser } from "@/lib/auth"
import { checkpointPath } from "@/lib/cloud/paths"
import { getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"
import { fileStore } from "@/lib/files"
import type { HandoffMeta } from "@/lib/harness/contract"
import { log } from "@/lib/log"

// Handoff and pull (H8, HD-11, ARCHITECTURE §3.4). A laptop's work becomes
// a workspace of the device's agent: the patch is stored as checkpoint 0-1
// (track C's format and path, PX-02), the row points at it with no sandbox,
// and one task is enqueued with the person's note; the worker's
// TaskWorkspace then imports the repository at baseSha and restores the
// patch. Access to the repository is proven only there (githubTarball).
// Nothing here imports lib/cloud beyond the pure paths helper (CT-IMP-03).
// Rows the person's session can't insert (workspaces, resource_usage) are
// privileged, scoped by the device's person.

const MB = 1024 * 1024
const PROVIDERS = ["local", "e2b", "daytona"] as const
type Provider = (typeof PROVIDERS)[number]

export type HandoffRefusal = { status: number; error: string; message: string }
const refuse = (status: number, error: string, message: string): HandoffRefusal => ({
  status,
  error,
  message,
})

// The configured provider while handoff and cloud workspaces are both on;
// null means the route says nothing (404)
export async function handoffProvider(): Promise<Provider | null> {
  if ((await getSetting("harness.handoff")) !== "on") return null
  if ((await getSetting("cloud.workspaces")) !== "on") return null
  const provider = await getSetting("cloud.provider")
  return PROVIDERS.find((name) => name === provider) ?? null
}

export const maxPatchBytes = async () =>
  (Number.parseInt((await getSetting("cloud.maxCheckpointMb")) ?? "", 10) || 50) * MB

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

// The checks that need no storage: the device's agent, a GitHub connection,
// a plan with workspace minutes, and the patch exactly as the meta says
export async function checkHandoff(
  device: DeviceUser,
  meta: z.infer<typeof HandoffMeta>,
  patch: Buffer
): Promise<HandoffRefusal | null> {
  if (!device.agentId) {
    return refuse(
      409,
      "no_agent",
      "Choose the agent this device works as in Kriya, Account → Devices."
    )
  }
  const [github] = await privileged
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.userId, device.id), eq(connections.provider, "github")))
    .limit(1)
  if (!github) {
    return refuse(
      403,
      "not_connected",
      "Connect GitHub in Kriya, Account → Apps, then hand off again."
    )
  }
  if (!((await getPlan(device.id)).workspaceMinutes > 0)) {
    return refuse(403, "plan_not_allowed", "Your plan doesn't include cloud workspaces.")
  }
  if (patch.length > (await maxPatchBytes())) {
    return refuse(413, "too_large", "The changes are larger than a handoff allows.")
  }
  if (patch.length !== meta.bytes || sha256(patch) !== meta.sha256) {
    return refuse(
      400,
      "patch_mismatch",
      "The upload was damaged on the way; hand off again."
    )
  }
  return null
}

// The note as the person's message: what was handed off, then their words
function handoffMessage(meta: z.infer<typeof HandoffMeta>, changes: boolean) {
  const what = `Handed off from my laptop: ${meta.repo} on ${meta.baseRef} at ${meta.baseSha.slice(0, 12)}${changes ? ", with my uncommitted changes" : ""}. Open the workspace (workspace_open) to continue there.`
  return meta.note?.trim() ? `${what}\n\n${meta.note.trim()}` : what
}

// After checkHandoff: the device has an agent
export async function handoff(
  device: DeviceUser,
  provider: Provider,
  meta: z.infer<typeof HandoffMeta>,
  patch: Buffer
): Promise<
  { threadId: string; workspaceId: string; taskId: string; url: string } | HandoffRefusal
> {
  const store = fileStore()
  const workspaceId = randomUUID()
  const changes = patch.length > 0
  const objectPath = changes ? checkpointPath(device.id, workspaceId, 0, 1) : null
  if (objectPath) {
    if (!store) throw new Error("no file store for checkpoints")
    await store.write(objectPath, patch, "text/x-diff")
  }

  let threadId: string | null = null
  try {
    const [thread] = await withUser(device.id, (tx) =>
      tx
        .insert(threads)
        .values({
          userId: device.id,
          agentId: device.agentId,
          title: `Handoff · ${meta.repo.split("/")[1]}`,
        })
        .returning({ id: threads.id })
    )
    threadId = thread.id
    await privileged.insert(workspaces).values({
      id: workspaceId,
      userId: device.id,
      threadId,
      agentId: device.agentId,
      repo: meta.repo,
      baseRef: meta.baseRef,
      baseSha: meta.baseSha,
      provider,
      image: (await getSetting("cloud.image")) ?? "local",
      size: (await getSetting("cloud.size")) ?? "2c-4g",
      network:
        (await getSetting("cloud.network")) === "offline" ? "offline" : "registries",
      ...(objectPath && {
        checkpointPath: objectPath,
        checkpointSha256: meta.sha256,
        checkpointBytes: patch.length,
        checkpointAt: new Date(),
        checkpointSeq: 1,
      }),
    })
    const task = await enqueueTurn({
      userId: device.id,
      threadId,
      agentId: device.agentId ?? undefined,
      message: {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text: handoffMessage(meta, changes) }],
      },
    })
    if (objectPath) {
      await privileged
        .insert(resourceUsage)
        .values({
          requestKey: `workspace-ckpt:${workspaceId}:0-1`,
          userId: device.id,
          taskId: task.id,
          kind: "workspace_storage_bytes",
          quantity: patch.length,
        })
        .onConflictDoNothing()
    }
    return {
      threadId,
      workspaceId,
      taskId: task.id,
      url: `${appUrl()}/a/${device.agentId}/${threadId}`,
    }
  } catch (error) {
    // Nothing half-made stays: the thread (its workspace row goes with it
    // below), the stored patch
    await undo(device.id, workspaceId, threadId, objectPath)
    if (error instanceof TurnError)
      return refuse(error.status, "task_refused", error.message)
    throw error
  }
}

async function undo(
  userId: string,
  workspaceId: string,
  threadId: string | null,
  objectPath: string | null
) {
  try {
    await privileged
      .delete(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
    if (threadId) {
      await withUser(userId, (tx) => tx.delete(threads).where(eq(threads.id, threadId)))
    }
    if (objectPath) await fileStore()?.remove([objectPath])
  } catch (error) {
    log.warn("handoff cleanup failed", { workspaceId, error: String(error) })
  }
}

// kriya pull: the latest checkpoint of one of the person's workspaces, read
// through their own session (RLS read_own), its digest checked again
export async function latestCheckpoint(userId: string, workspaceId: string) {
  const [row] = await withUser(userId, (tx) =>
    tx
      .select({
        path: workspaces.checkpointPath,
        sha256: workspaces.checkpointSha256,
        baseSha: workspaces.baseSha,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
  )
  if (!row) return null
  if (!row.path || !row.sha256 || !row.baseSha) return "none" as const
  const store = fileStore()
  if (!store) throw new Error("no file store for checkpoints")
  const patch = await store.read(row.path)
  if (!patch || sha256(patch) !== row.sha256) {
    throw new Error("the workspace's checkpoint couldn't be read")
  }
  return { patch, sha256: row.sha256, baseSha: row.baseSha }
}
