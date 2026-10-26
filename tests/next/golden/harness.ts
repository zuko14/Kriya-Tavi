import { enqueueApproval } from "@/lib/agent/queue"
import { deliveryOf, type DeliveryCheck } from "@/lib/delivery/status"

import { type World } from "../../operator/golden/harness"

// What every golden scenario reads back: the person's pending asks answered
// the way a person would, and the task's record with the status code computed
// for it (never what the model said).

// Answers the oldest pending approval the way a person would, and runs the
// task it resumes. Returns false when nothing was waiting.
export async function answerNext(w: World, approved = true) {
  const [ask] = await w.q<{ id: string; thread_id: string }>(
    "select id, thread_id from kriya.approvals where status = 'pending' order by created_at limit 1"
  )
  if (!ask) return false
  await enqueueApproval({
    userId: w.user,
    threadId: ask.thread_id,
    approvalId: ask.id,
    approved,
  })
  await w.runQueued()
  return true
}

// Answers every pending approval, one after the other, until none is waiting.
// Returns how many were answered.
export async function answerAll(w: World, approved = true) {
  let answered = 0
  while (answered < 12 && (await answerNext(w, approved))) answered++
  return answered
}

type EpisodeRow = {
  task_id: string
  done: { tool: string; title: string; executionId: string }[]
  unconfirmed: { claim: string; reason: string; executionId?: string }[]
  checks: unknown[]
}

// The latest record of the person's, with its delivery status
export async function delivery(w: World, threadId = "chat") {
  const [episode] = await w.q<EpisodeRow>(
    "select task_id, done, unconfirmed, checks from kriya.episodes where thread_id = $1 order by seq desc limit 1",
    [threadId]
  )
  if (!episode) return null
  const checks = await w.q<DeliveryCheck>(
    `select execution_id as "executionId", status, kind from kriya.delivery_checks where task_id = $1`,
    [episode.task_id]
  )
  return {
    taskId: episode.task_id,
    episode,
    checks,
    ...deliveryOf(episode as never, checks),
  }
}

export const runsOf = (w: World, tool: string) =>
  w.q<{
    id: string
    status: string
    side_effect: boolean
    risk: string | null
    verification: { status: string } | null
    input: unknown
  }>(
    "select id, status, side_effect, risk, verification, input from kriya.tool_executions where tool_name = $1 order by started_at",
    [tool]
  )
