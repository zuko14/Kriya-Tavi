import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  requestUndo,
  runUndos,
  UNDO_WINDOW_MS,
  undoColumns,
  undoOf,
  undoStates,
} from "@/lib/undo"

import { connectedUser, REPO, serve } from "../connectors/fixtures"
import { asUser, createUser, type TestDb } from "../db/harness"

// K3 Undo window (AD-29). AT-UNDO-01: only inside the 10-minute window,
// once, and only by the owner. AT-UNDO-02: the compensation runs in the
// worker and counts only when a read-back confirms it. AT-UNDO-03: tools
// without a reliable reverse record nothing, so they get no button.

let pg: TestDb
let user: string
let task: string

const verified = { status: "verified", method: "api_readback", evidence: [] }

async function execution(
  tool: string,
  undo: object | null,
  until: "future" | "past" = "future"
) {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tool_executions
       (task_id, user_id, attempt, tool_call_id, tool_name, side_effect, status, finished_at, undo, undo_until)
     values ($1, $2, 1, $3, $4, true, 'succeeded', now(), $5, $6) returning id`,
    [
      task,
      user,
      `call-${Math.random().toString(36).slice(2)}`,
      tool,
      undo ? JSON.stringify(undo) : null,
      undo
        ? new Date(Date.now() + (until === "future" ? 5 : -1) * 60_000).toISOString()
        : null,
    ]
  )
  return rows[0].id
}

const compensations = async () =>
  (
    await pg.query<{
      tool_name: string
      status: string
      input: unknown
      side_effect: boolean
    }>(
      "select tool_name, status, input, side_effect from kriya.tool_executions where tool_call_id like 'undo:%'"
    )
  ).rows

const COMMENT = { kind: "github_comment", repo: REPO, commentId: 9001 }

beforeEach(async () => {
  ;({ pg, userId: user } = await connectedUser(["github"]))
  await asUser(pg, user, async (tx) => {
    await tx.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Dev', 'r', 'g')",
      [user]
    )
    await tx.query(
      "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
      [user]
    )
  })
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.tasks (user_id, thread_id, input, plan_id, tier, deadline_at, step_budget, cost_budget_micro_usd)
     values ($1, 't1', '{}', 'free', 'budget', now() + interval '1 hour', 10, 1000) returning id`,
    [user]
  )
  task = rows[0].id
})
afterEach(() => vi.unstubAllGlobals())

describe("AT-UNDO-01: only inside the window, once, by the owner", () => {
  it("queues one compensation in the same transaction that marks the run", async () => {
    const id = await execution("github_comment", COMMENT)
    expect(await requestUndo(user, id)).toEqual({ ok: true })
    expect(await compensations()).toEqual([
      {
        tool_name: "undo:github_comment",
        status: "running",
        input: COMMENT,
        side_effect: true,
      },
    ])
    const { rows } = await pg.query<{ undone_at: Date | null }>(
      "select undone_at from kriya.tool_executions where id = $1",
      [id]
    )
    expect(rows[0].undone_at).not.toBeNull()
  })

  it("a second click finds it already undone and queues nothing more", async () => {
    const id = await execution("github_comment", COMMENT)
    await requestUndo(user, id)
    expect(await requestUndo(user, id)).toEqual({
      error: "That action is already being undone.",
    })
    expect(await compensations()).toHaveLength(1)
  })

  it("after 10 minutes it is refused", async () => {
    const id = await execution("github_comment", COMMENT, "past")
    expect(await requestUndo(user, id)).toEqual({
      error: "The 10-minute undo window has closed.",
    })
    expect(await compensations()).toEqual([])
  })

  it("someone else can't undo it, or even see it", async () => {
    const id = await execution("github_comment", COMMENT)
    const other = await createUser(pg)
    expect(await requestUndo(other, id)).toEqual({ error: "That action wasn't found." })
    expect(await compensations()).toEqual([])
  })

  it("the person's session can't set undone_at directly (only the action can)", async () => {
    const id = await execution("github_comment", COMMENT)
    await expect(
      asUser(pg, user, (tx) =>
        tx.query("update kriya.tool_executions set undone_at = now() where id = $1", [id])
      )
    ).rejects.toThrow(/permission denied/)
  })
})

describe("AT-UNDO-02: verified by read-back", () => {
  const COMMENT_URL =
    /^https:\/\/api\.github\.com\/repos\/octo-org\/kriya-demo\/issues\/comments\/9001$/

  it("runs the compensation and records it as verified", async () => {
    const id = await execution("github_comment", COMMENT)
    await requestUndo(user, id)
    serve([
      { method: "DELETE", url: COMMENT_URL, status: 204 },
      { url: COMMENT_URL, status: 404, body: {} },
    ])
    expect(await runUndos()).toBe(1)
    const [row] = (
      await pg.query<{ status: string; verification: { status: string } }>(
        "select status, verification from kriya.tool_executions where tool_call_id like 'undo:%'"
      )
    ).rows
    expect(row.status).toBe("succeeded")
    expect(row.verification.status).toBe("verified")
    expect(await undoStates(user, [id])).toEqual([
      expect.objectContaining({ executionId: id, state: "done", verb: "Undo" }),
    ])
    // Nothing left to run
    expect(await runUndos()).toBe(0)
  })

  it("a read-back that still finds it is a failure, never 'undone'", async () => {
    const id = await execution("github_comment", COMMENT)
    await requestUndo(user, id)
    serve([
      { method: "DELETE", url: COMMENT_URL, status: 204 },
      { url: COMMENT_URL, body: { id: 9001 } },
    ])
    await runUndos()
    expect(await undoStates(user, [id])).toEqual([
      expect.objectContaining({
        state: "failed",
        error: "The read-back shows it is still there.",
      }),
    ])
  })

  it("a provider error is recorded as a failure with its message", async () => {
    const id = await execution("github_comment", COMMENT)
    await requestUndo(user, id)
    serve([{ method: "DELETE", url: COMMENT_URL, status: 403, body: {} }])
    await runUndos()
    expect((await undoStates(user, [id]))[0]).toMatchObject({
      state: "failed",
      error: "Deleting the comment failed (403).",
    })
  })
})

describe("AT-UNDO-03: no button for tools without a reliable reverse", () => {
  it("records nothing for tools that can't be reversed", () => {
    for (const tool of [
      "sheets_append",
      "sheets_update",
      "instagram_publish",
      "github_open_pr",
      "youtube_stats",
      "browser_click",
      "web_fetch",
    ]) {
      expect(undoOf(tool, { verification: verified, id: "x" }), tool).toBeNull()
      expect(undoColumns(tool, { verification: verified }), tool).toEqual({})
    }
  })

  it("records GitHub reverses only for verified runs, and labels only if any were added", () => {
    expect(undoOf("github_comment", { repo: REPO, commentId: 1 })).toBeNull()
    expect(
      undoOf("github_label", { verification: verified, repo: REPO, number: 7, added: [] })
    ).toBeNull()
    expect(
      undoOf("github_label", {
        verification: verified,
        repo: REPO,
        number: 7,
        added: ["ui"],
      })
    ).toEqual({ kind: "github_labels", repo: REPO, number: 7, labels: ["ui"] })
    expect(
      undoOf("github_create_issue", { verification: verified, repo: REPO, number: 12 })
    ).toEqual({ kind: "github_issue", repo: REPO, number: 12 })
  })

  it("calendar events say whether invitees will hear; the window is 10 minutes", () => {
    const now = Date.UTC(2026, 9, 18, 10)
    expect(
      undoColumns("calendar_create_event", { id: "e1", attendees: ["a@x.test"] }, now)
    ).toEqual({
      undo: { kind: "calendar_event", eventId: "e1", notifies: true },
      undoUntil: new Date(now + UNDO_WINDOW_MS),
    })
    expect(undoOf("calendar_create_event", { id: "e1", attendees: [] })).toMatchObject({
      notifies: false,
    })
    expect(undoOf("gmail_draft", { draftId: "d1" })).toEqual({
      kind: "gmail_draft",
      draftId: "d1",
    })
  })

  it("lists undo states only for runs that recorded a reverse", async () => {
    const reversible = await execution("github_comment", COMMENT)
    const other = await execution("sheets_append", null)
    const states = await undoStates(user, [reversible, other])
    expect(states.map((s) => s.executionId)).toEqual([reversible])
    expect(states[0]).toMatchObject({ state: "available", label: "Delete the comment." })
  })

  it("an issue is offered as Close, with the reason", async () => {
    const id = await execution("github_create_issue", {
      kind: "github_issue",
      repo: REPO,
      number: 12,
    })
    expect((await undoStates(user, [id]))[0]).toMatchObject({
      verb: "Close",
      label: expect.stringContaining("not planned"),
    })
  })
})
