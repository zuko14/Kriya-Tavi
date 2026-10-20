import { randomBytes } from "node:crypto"

import type { TestDb } from "./harness"

// Shared rows for the voice database tests (phase 1). The phone number is
// synthetic.

export const HASH = "a".repeat(64)
export const PHONE = "+919876543210"
export const now = () => new Date().toISOString()

type Row = Record<string, unknown>

// Inserts a row at any status, the way the migration's own function does:
// the status guard lets it through only while kriya.transition is on
export async function seed(pg: TestDb, table: string, row: Row) {
  const keys = Object.keys(row)
  const values = Object.values(row).map((value) =>
    value !== null && typeof value === "object" ? JSON.stringify(value) : value
  )
  return pg.transaction(async (tx) => {
    await tx.query("select set_config('kriya.transition', 'on', true)")
    const { rows } = await tx.query<Row>(
      `insert into kriya.${table} (${keys.join(", ")})
       values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
      values
    )
    return rows[0]
  })
}

const idOf = (row: Row) => row.id as string

export const voiceTask = (pg: TestDb, user: string, row: Row = {}) =>
  seed(pg, "voice_tasks", {
    user_id: user,
    recipient_label: "my CA",
    recipient_phone_e164: PHONE,
    recipient_phone_hash: HASH,
    purpose: "Ask whether 3 PM tomorrow works",
    spec: {},
    plan_id: "free",
    max_call_seconds: 300,
    cost_budget_micro_inr: 1_000_000,
    ...row,
  }).then(idOf)

let seq = 0
export const voiceCall = (pg: TestDb, user: string, task: string, row: Row = {}) =>
  seed(pg, "voice_calls", {
    user_id: user,
    voice_task_id: task,
    kind: "outreach",
    seq: ++seq,
    to_phone_e164: PHONE,
    not_before: now(),
    available_at: now(),
    max_attempts: 2,
    ...row,
  }).then(idOf)

let attempt = 0
export const callAttempt = (pg: TestDb, user: string, call: string, row: Row = {}) =>
  seed(pg, "call_attempts", {
    user_id: user,
    voice_call_id: call,
    attempt: ++attempt,
    policy_version: "baseline",
    // Unique per attempt, as real tokens are
    callback_token_hash: randomBytes(32).toString("hex"),
    stream_token_hash: randomBytes(32).toString("hex"),
    ...row,
  }).then(idOf)

export const callOutcome = (
  pg: TestDb,
  user: string,
  task: string,
  callAttemptId: string,
  row: Row = {}
) =>
  seed(pg, "call_outcomes", {
    user_id: user,
    voice_task_id: task,
    call_attempt_id: callAttemptId,
    observed: {},
    verifier_status: "accepted",
    ...row,
  }).then(idOf)

export const approval = (pg: TestDb, user: string, task: string, row: Row = {}) =>
  seed(pg, "voice_approvals", {
    user_id: user,
    voice_task_id: task,
    kind: "outreach_call",
    payload: {},
    payload_hash: HASH,
    status: "approved",
    ...row,
  }).then(idOf)

export async function transition(
  pg: Pick<TestDb, "query">,
  entity: string,
  id: string,
  to: string,
  actor: string,
  evidence: Row = {}
) {
  const { rows } = await pg.query<{ ok: boolean }>(
    "select kriya.voice_transition($1, $2::uuid, $3, $4, $5::jsonb) as ok",
    [entity, id, to, actor, JSON.stringify(evidence)]
  )
  return rows[0].ok
}

export const TABLES = {
  task: "voice_tasks",
  call: "voice_calls",
  attempt: "call_attempts",
} as const

export async function statusOf(pg: TestDb, entity: keyof typeof TABLES, id: string) {
  const { rows } = await pg.query<{ status: string }>(
    `select status from kriya.${TABLES[entity]} where id = $1`,
    [id]
  )
  return rows[0]?.status
}
