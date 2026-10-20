import { randomUUID } from "node:crypto"

import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"
import {
  approval,
  callAttempt,
  callOutcome,
  HASH,
  now,
  statusOf,
  TABLES,
  transition,
  voiceCall,
  voiceTask,
} from "./voice-fixtures"

let pg: TestDb
let user: string

beforeAll(async () => {
  pg = await createTestDb()
  user = await createUser(pg)
})

type Entity = keyof typeof TABLES
type Edge = {
  entity: Entity
  from_status: string
  to_status: string
  actors: string[]
  evidence: string[]
}

const transitionsOf = async (id: string) =>
  (
    await pg.query<{ from_status: string; to_status: string; actor: string }>(
      "select from_status, to_status, actor from kriya.voice_transitions where entity_id = $1 order by id",
      [id]
    )
  ).rows

// A row at the edge's from-status, with whatever the edge's checks look up,
// and evidence that satisfies them
async function ready(edge: Edge) {
  const { entity, from_status: from, to_status: to } = edge
  const evidence: Record<string, unknown> = {}
  for (const key of edge.evidence) {
    evidence[key] = key.endsWith("_id")
      ? randomUUID()
      : key === "result"
        ? "agreed"
        : key === "verified_at"
          ? now()
          : "evidence"
  }
  if (entity === "task") {
    const id = await voiceTask(pg, user, {
      status: from,
      report_requested: false,
      cancel_requested_at: to === "cancelled" ? now() : null,
    })
    if (to === "authorized") {
      evidence.approval_id = await approval(pg, user, id)
      evidence.payload_hash = HASH
    }
    if (from === "in_progress" && to === "awaiting_report") {
      const call = await voiceCall(pg, user, id, { status: "settled" })
      const attempt = await callAttempt(pg, user, call, {
        status: "ended",
        verified_at: now(),
      })
      await callOutcome(pg, user, id, attempt)
      evidence.attempt_id = attempt
    }
    if (to === "unreported") {
      evidence.voice_call_id = await voiceCall(pg, user, id, {
        kind: "owner_report",
        status: "exhausted",
      })
    }
    return { id, evidence }
  }
  const task = await voiceTask(pg, user, { status: "in_progress" })
  if (entity === "call") {
    const id = await voiceCall(pg, user, task, {
      status: from,
      kind: from === "settled" ? "owner_report" : "outreach",
      cancel_requested_at: to === "canceled" ? now() : null,
    })
    return { id, evidence }
  }
  const call = await voiceCall(pg, user, task, { status: "dialing" })
  return { id: await callAttempt(pg, user, call, { status: from }), evidence }
}

describe("voice state machines", () => {
  it("T-SM-01 every allowed edge succeeds with each allowed actor and its evidence", async () => {
    const { rows: edges } = await pg.query<Edge>(
      "select * from kriya.voice_allowed_transitions order by entity, from_status, to_status"
    )
    expect(edges.length).toBeGreaterThan(50)
    const failures: string[] = []
    for (const edge of edges) {
      for (const actor of edge.actors) {
        const name = `${edge.entity} ${edge.from_status} → ${edge.to_status} by ${actor}`
        try {
          const { id, evidence } = await ready(edge)
          const ok = await transition(
            pg,
            edge.entity,
            id,
            edge.to_status,
            actor,
            evidence
          )
          const status = await statusOf(pg, edge.entity, id)
          const audit = await transitionsOf(id)
          if (!ok || status !== edge.to_status) failures.push(`${name}: ${ok} ${status}`)
          else if (
            JSON.stringify(audit) !==
            JSON.stringify([
              { from_status: edge.from_status, to_status: edge.to_status, actor },
            ])
          )
            failures.push(`${name}: audit ${JSON.stringify(audit)}`)
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it("T-SM-01 sets the matching timestamps once", async () => {
    const task = await voiceTask(pg, user, { status: "in_progress" })
    const call = await voiceCall(pg, user, task, { status: "dialing" })
    const attempt = await callAttempt(pg, user, call)
    expect(await transition(pg, "attempt", attempt, "requested", "worker")).toBe(true)
    expect(
      await transition(pg, "attempt", attempt, "initiated", "worker", {
        provider_call_id: "CA-1",
      })
    ).toBe(true)
    expect(await transition(pg, "attempt", attempt, "answered", "webhook")).toBe(true)
    expect(await transition(pg, "attempt", attempt, "connected", "voice")).toBe(true)
    expect(await transition(pg, "attempt", attempt, "ended", "voice")).toBe(true)
    const { rows } = await pg.query(
      `select provider_call_id, requested_at is not null as requested, initiated_at is not null as initiated,
              ringing_at is null as never_rang, answered_at is not null as answered,
              connected_at is not null as connected, ended_at is not null as ended
       from kriya.call_attempts where id = $1`,
      [attempt]
    )
    expect(rows).toEqual([
      {
        provider_call_id: "CA-1",
        requested: true,
        initiated: true,
        never_rang: true,
        answered: true,
        connected: true,
        ended: true,
      },
    ])
  })

  it("T-SM-02 refuses the rejected examples", async () => {
    const task = await voiceTask(pg, user, { status: "in_progress" })
    const call = await voiceCall(pg, user, task, { status: "dialing" })
    // Edges that don't exist are no-ops
    for (const [from, to] of [
      ["created", "connected"],
      ["ended", "connected"],
      ["busy", "answered"],
    ]) {
      const attempt = await callAttempt(pg, user, call, { status: from })
      expect(await transition(pg, "attempt", attempt, to, "webhook")).toBe(false)
      expect(await statusOf(pg, "attempt", attempt)).toBe(from)
    }
    expect(await transition(pg, "task", task, "completed", "verifier")).toBe(false)
    expect(await statusOf(pg, "task", task)).toBe("in_progress")

    // Completed by the voice service, or with no delivery evidence
    const reporting = await voiceTask(pg, user, { status: "awaiting_report" })
    await expect(
      transition(pg, "task", reporting, "completed", "voice", { result: "agreed" })
    ).rejects.toThrow(/can't move/)
    await expect(
      transition(pg, "task", reporting, "completed", "verifier", { result: "agreed" })
    ).rejects.toThrow(/delivered report/)
    expect(await statusOf(pg, "task", reporting)).toBe("awaiting_report")

    // Approving with a stale payload hash
    const confirming = await voiceTask(pg, user, { status: "awaiting_confirmation" })
    const approvalId = await approval(pg, user, confirming)
    await expect(
      transition(pg, "task", confirming, "authorized", "owner", {
        approval_id: approvalId,
        payload_hash: "b".repeat(64),
      })
    ).rejects.toThrow(/approval/)
    expect(await statusOf(pg, "task", confirming)).toBe("awaiting_confirmation")
    expect(await transitionsOf(confirming)).toEqual([])
  })

  it("T-SM-02 raises on a wrong actor, missing evidence, unknown entity or row", async () => {
    const task = await voiceTask(pg, user, { status: "draft" })
    await expect(
      transition(pg, "task", task, "awaiting_confirmation", "voice")
    ).rejects.toThrow(/can't move/)
    const authorized = await voiceTask(pg, user, { status: "authorized" })
    await expect(
      transition(pg, "task", authorized, "in_progress", "worker")
    ).rejects.toThrow(/voice_call_id/)
    await expect(transition(pg, "thread", task, "draft", "owner")).rejects.toThrow(
      /unknown voice entity/
    )
    await expect(
      transition(pg, "task", randomUUID(), "cancelled", "owner")
    ).rejects.toThrow(/not found/)
    expect(await transitionsOf(task)).toEqual([])
  })

  it("T-SM-03 out-of-order and duplicate events change nothing and record nothing", async () => {
    const task = await voiceTask(pg, user, { status: "in_progress" })
    const call = await voiceCall(pg, user, task, { status: "dialing" })
    const attempt = await callAttempt(pg, user, call, { status: "initiated" })
    expect(await transition(pg, "attempt", attempt, "ringing", "webhook")).toBe(true)
    // The same callback twice
    expect(await transition(pg, "attempt", attempt, "ringing", "webhook")).toBe(false)
    expect(await transition(pg, "attempt", attempt, "answered", "webhook")).toBe(true)
    // A late ringing callback after answered
    expect(await transition(pg, "attempt", attempt, "ringing", "webhook")).toBe(false)
    expect(await transition(pg, "attempt", attempt, "initiated", "webhook")).toBe(false)
    expect(await statusOf(pg, "attempt", attempt)).toBe("answered")
    expect((await transitionsOf(attempt)).map((t) => t.to_status)).toEqual([
      "ringing",
      "answered",
    ])
  })

  it("T-SM-04 refuses direct status changes from a person and from the privileged role", async () => {
    const task = await voiceTask(pg, user, { status: "awaiting_report" })
    const call = await voiceCall(pg, user, task, { status: "in_call" })
    const attempt = await callAttempt(pg, user, call, { status: "connected" })

    // A browser session has no update grant at all
    for (const [table, id] of [
      ["voice_tasks", task],
      ["voice_calls", call],
      ["call_attempts", attempt],
    ]) {
      await expect(
        asUser(pg, user, (tx) =>
          tx.query(`update kriya.${table} set status = 'completed' where id = $1`, [id])
        )
      ).rejects.toThrow(/permission denied/)
    }
    await expect(
      asUser(pg, user, (tx) => transition(tx, "task", task, "cancelled", "owner"))
    ).rejects.toThrow(/permission denied/)

    // The privileged connection is stopped by the trigger
    await expect(
      pg.query("update kriya.voice_tasks set status = 'completed' where id = $1", [task])
    ).rejects.toThrow(/voice_transition/)
    await expect(
      pg.query("update kriya.voice_tasks set result = 'agreed' where id = $1", [task])
    ).rejects.toThrow(/voice_transition/)
    await expect(
      pg.query("update kriya.voice_calls set status = 'settled' where id = $1", [call])
    ).rejects.toThrow(/voice_transition/)
    await expect(
      pg.query("update kriya.call_attempts set status = 'ended' where id = $1", [attempt])
    ).rejects.toThrow(/voice_transition/)
    // Nor can a row start life at a later status
    await expect(
      pg.query(
        `insert into kriya.voice_tasks (user_id, status, recipient_label, recipient_phone_e164,
           recipient_phone_hash, purpose, spec, plan_id, max_call_seconds, cost_budget_micro_inr)
         values ($1, 'completed', 'x', '+919876543210', $2, 'x', '{}', 'free', 60, 1)`,
        [user, HASH]
      )
    ).rejects.toThrow(/voice_transition/)

    // Updates that leave the status alone still work
    await pg.query("update kriya.voice_calls set heartbeat_at = now() where id = $1", [
      call,
    ])

    // The function's own permission doesn't outlive it in the same transaction
    const other = await voiceTask(pg, user, { status: "draft" })
    await expect(
      pg.transaction(async (tx) => {
        await transition(tx, "task", other, "awaiting_confirmation", "owner")
        await tx.query(
          "update kriya.voice_tasks set status = 'authorized' where id = $1",
          [other]
        )
      })
    ).rejects.toThrow(/voice_transition/)
    expect(await statusOf(pg, "task", other)).toBe("draft")

    // The audit trail is append-only
    await transition(pg, "task", other, "awaiting_confirmation", "owner")
    await expect(
      pg.query(
        "update kriya.voice_transitions set actor = 'owner' where entity_id = $1",
        [other]
      )
    ).rejects.toThrow(/append-only/)
  })

  it("T-SM-05 completed needs a delivered report unless none was requested", async () => {
    const task = await voiceTask(pg, user, { status: "awaiting_report" })
    const report = await voiceCall(pg, user, task, {
      kind: "owner_report",
      status: "settled",
    })
    await expect(
      transition(pg, "task", task, "completed", "verifier", {
        result: "agreed",
        voice_call_id: report,
      })
    ).rejects.toThrow(/delivered report/)
    await pg.query("update kriya.voice_calls set delivered_at = now() where id = $1", [
      report,
    ])
    expect(
      await transition(pg, "task", task, "completed", "verifier", {
        result: "agreed",
        voice_call_id: report,
      })
    ).toBe(true)
    const { rows } = await pg.query(
      "select status, result, finished_at is not null as finished from kriya.voice_tasks where id = $1",
      [task]
    )
    expect(rows).toEqual([{ status: "completed", result: "agreed", finished: true }])

    // A result outside the list is refused by the column check
    const other = await voiceTask(pg, user, {
      status: "awaiting_report",
      report_requested: false,
    })
    await expect(
      transition(pg, "task", other, "completed", "verifier", { result: "done" })
    ).rejects.toThrow()
  })

  it("T-SM-05 awaiting_report needs the last outreach attempt verified and accepted", async () => {
    const task = await voiceTask(pg, user, { status: "in_progress" })
    const call = await voiceCall(pg, user, task, { status: "settled" })
    const first = await callAttempt(pg, user, call, {
      status: "busy",
      verified_at: now(),
    })
    const last = await callAttempt(pg, user, call, { status: "ended" })
    const move = (attempt: string) =>
      transition(pg, "task", task, "awaiting_report", "verifier", {
        attempt_id: attempt,
        verified_at: now(),
      })

    // Not verified yet
    await expect(move(last)).rejects.toThrow(/verified attempt/)
    await pg.query("update kriya.call_attempts set verified_at = now() where id = $1", [
      last,
    ])
    // Verified, but the outcome needs review
    const outcome = await callOutcome(pg, user, task, last, {
      verifier_status: "needs_review",
    })
    await expect(move(last)).rejects.toThrow(/verified attempt/)
    await pg.query(
      "update kriya.call_outcomes set verifier_status = 'accepted' where id = $1",
      [outcome]
    )
    // Not the last attempt
    await expect(move(first)).rejects.toThrow(/verified attempt/)
    expect(await move(last)).toBe(true)
  })

  it("T-SM-05 cancelling needs a request and no live call", async () => {
    const task = await voiceTask(pg, user, { status: "in_progress" })
    await expect(transition(pg, "task", task, "cancelled", "owner")).rejects.toThrow(
      /cancel/
    )
    await pg.query(
      "update kriya.voice_tasks set cancel_requested_at = now() where id = $1",
      [task]
    )
    const call = await voiceCall(pg, user, task, { status: "in_call" })
    const attempt = await callAttempt(pg, user, call, { status: "connected" })
    await expect(transition(pg, "task", task, "cancelled", "owner")).rejects.toThrow(
      /live/
    )
    await transition(pg, "attempt", attempt, "ended", "voice")
    expect(await transition(pg, "task", task, "cancelled", "owner")).toBe(true)
  })
})
