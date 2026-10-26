"use server"

import { and, eq, isNull } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { episodes } from "@/db/schema"
import { verifyChain } from "@/lib/agent/episodes"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { deliveryView } from "@/lib/delivery/status"
import { undoStates, type UndoState } from "@/lib/undo"
import {
  deliveryForTasks,
  episodesForTasks,
  jobsForExecutions,
  recheckDue,
} from "@/queries/episodes"
import { inboxCount } from "@/queries/inbox"

// The Inbox badge and "What I did" (A3, agents.inbox), and the receipt's
// "Verify my records" and delete (K1, agents.receipts). Answering an
// approval stays on POST /api/threads/[threadId]/approvals.

const inboxOn = async () => (await getSetting("agents.inbox")) === "on"

// The tab's count, or null when the Inbox is switched off (no tab at all)
export async function inboxBadge(): Promise<number | null> {
  const user = await requireUser()
  if (!(await inboxOn())) return null
  return inboxCount(user.id)
}

const taskIds = z.array(z.uuid()).max(100)

// The records under a thread's replies, by task, with the receipt fields
// only when receipts are on
export async function whatIDid(ids: string[]) {
  const user = await requireUser()
  const parsed = taskIds.safeParse(ids)
  if (!parsed.success || !(await inboxOn())) return { receipts: false, records: [] }
  const receipts = (await getSetting("agents.receipts")) === "on"
  // A5: Download PDF and Share on a receipt
  const shareable = receipts && (await getSetting("agents.files")) === "on"
  const records = await episodesForTasks(user.id, parsed.data)
  // K3: the Undo state of each listed action that can be reversed
  const undo: UndoState[] =
    (await getSetting("agents.undo")) === "on"
      ? await undoStates(
          user.id,
          records.flatMap((r) => (r.deletedAt ? [] : r.done.map((d) => d.executionId)))
        )
      : []
  // O4: "under your job" for runs a standing grant answered
  const jobs =
    (await getSetting("operator.grants")) === "on"
      ? await jobsForExecutions(
          user.id,
          records.flatMap((r) =>
            [...r.done, ...r.unconfirmed].flatMap((d) => d.executionId ?? [])
          )
        )
      : {}
  // N2 (ND-03, ND-23): the delivery line, only with next.delivery on (this
  // action already answers nothing without agents.inbox); off = today's records
  const checks =
    (await getSetting("next.delivery")) === "on"
      ? await deliveryForTasks(
          user.id,
          records.flatMap((r) => (r.taskId ? [r.taskId] : []))
        )
      : null
  // N3: which unconfirmed runs still wait for their one late re-check
  // (next.recheck needs next.delivery, ND-23)
  const due =
    checks && (await getSetting("next.recheck")) === "on"
      ? await recheckDue(
          user.id,
          records.flatMap((r) => r.unconfirmed.flatMap((u) => u.executionId ?? []))
        )
      : null
  return {
    receipts,
    records: records.map((record) => ({
      ...record,
      ...(checks && {
        delivery: {
          ...deliveryView(
            record,
            checks.filter((check) => check.taskId === record.taskId)
          ),
          ...(due && {
            due: due.filter((d) =>
              record.unconfirmed.some((u) => u.executionId === d.executionId)
            ),
          }),
        },
      }),
      jobs,
      undo: undo.filter((u) => record.done.some((d) => d.executionId === u.executionId)),
      shareable,
      ...(!receipts && { hash: null, chargeMicroInr: null, chargeStatus: null }),
    })),
  }
}

export type WhatIDid = Awaited<ReturnType<typeof whatIDid>>

// Recomputes the person's receipt chain (K1)
export async function verifyMyRecords() {
  const user = await requireUser()
  if ((await getSetting("agents.receipts")) !== "on") return null
  return verifyChain(user.id)
}

// The person's delete: the content goes, the record's place in the chain
// stays, so the chain shows the gap honestly (DATA_MODEL §2.3)
export async function deleteRecord(episodeId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(episodeId)
  if (!id.success) return { error: "That record wasn't found." }
  await withUser(user.id, (tx) =>
    tx
      .update(episodes)
      .set({
        deletedAt: new Date(),
        done: [],
        unconfirmed: [],
        checks: [],
        titles: null,
        summary: null,
      })
      .where(and(eq(episodes.id, id.data), isNull(episodes.deletedAt)))
  )
  revalidatePath("/", "layout")
  return { ok: true as const }
}
