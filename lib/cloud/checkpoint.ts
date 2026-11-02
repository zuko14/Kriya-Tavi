import { createHash } from "node:crypto"

import { privileged } from "@/db"
import { resourceUsage, type workspaces } from "@/db/schema"
import type { RunnerClient } from "@/lib/cloud/client"
import { checkpointPath } from "@/lib/cloud/paths"
import { type FileStore } from "@/lib/files"
import { log } from "@/lib/log"

// Checkpoints (CD-13): the runner's patch from the base commit, stored in
// the private kriya-files bucket under workspaces/<user_id>/, never a
// kriya.files row and never a signed URL. The latest two are kept while the
// workspace is open; all go when it closes. Used by TaskWorkspace (end of a
// task, before a publish) and by the janitor.

type Row = typeof workspaces.$inferSelect

export type CheckpointAt = {
  userId: string
  workspaceId: string
  generation: number
  // The workspace's latest checkpoint: its sequence and digest
  seq: number
  sha256: string | null
  taskId: string | null
}

// Every name a checkpoint with this sequence could have: the generation in
// the name is the sandbox's at the time, any of 0…generation
const named = (at: CheckpointAt, seqs: number[]) =>
  seqs
    .filter((seq) => seq > 0)
    .flatMap((seq) =>
      Array.from({ length: at.generation + 1 }, (_, g) =>
        checkpointPath(at.userId, at.workspaceId, g, seq)
      )
    )

// A new checkpoint when the tree differs from the last one; the row fields
// to write. A failed checkpoint returns checkpointFailedAt: the sandbox is
// then never destroyed (CS-14)
export async function saveCheckpoint(
  store: FileStore | null,
  client: RunnerClient,
  at: CheckpointAt
): Promise<Partial<Row>> {
  try {
    const { patch, sha256, changes } = await client.checkpoint()
    // The runner's digest is checked against the bytes before anything is
    // stored: a damaged patch is a failed checkpoint, never a stored one a
    // restore can't use (re-audit 2026-11-02)
    if (createHash("sha256").update(patch).digest("hex") !== sha256)
      throw new Error("the checkpoint didn't match its sha256")
    if (sha256 === at.sha256) return { changes, checkpointFailedAt: null }
    if (!at.sha256 && changes.files === 0) return { changes, checkpointFailedAt: null }
    if (!store) throw new Error("no file store for checkpoints")
    const seq = at.seq + 1
    const objectPath = checkpointPath(at.userId, at.workspaceId, at.generation, seq)
    await store.write(objectPath, patch, "text/x-diff")
    await privileged
      .insert(resourceUsage)
      .values({
        requestKey: `workspace-ckpt:${at.workspaceId}:${at.generation}-${seq}`,
        userId: at.userId,
        taskId: at.taskId,
        kind: "workspace_storage_bytes",
        quantity: patch.length,
      })
      .onConflictDoNothing()
    // The one before the previous; the previous stays until the row points
    // at the new one
    await store.remove(named(at, [seq - 2])).catch((error) =>
      log.warn("old workspace checkpoint not deleted", {
        workspaceId: at.workspaceId,
        error: String(error),
      })
    )
    return {
      checkpointPath: objectPath,
      checkpointSha256: sha256,
      checkpointBytes: patch.length,
      checkpointAt: new Date(),
      checkpointSeq: seq,
      checkpointFailedAt: null,
      changes,
    }
  } catch (error) {
    log.warn("workspace checkpoint failed", {
      workspaceId: at.workspaceId,
      taskId: at.taskId,
      error: String(error),
    })
    return { checkpointFailedAt: new Date() }
  }
}

// When a workspace closes: its latest two checkpoints. Throws when storage
// refuses, so the workspace stays open for the next run
export async function deleteCheckpoints(store: FileStore | null, at: CheckpointAt) {
  if (at.seq === 0) return
  if (!store) throw new Error("no file store for checkpoints")
  await store.remove(named(at, [at.seq - 1, at.seq]))
}
