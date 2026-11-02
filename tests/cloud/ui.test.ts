import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeAll, describe, expect, it, vi } from "vitest"

// What the person sees of a cloud workspace (UX_SPEC §2–3, TEST_STRATEGY
// CT-UI-01…04) as server-rendered markup, plus the strip's data, the close
// action and the plan field on PGlite. Sizes, themes and the dialog are the
// browser check's (UX_SPEC §6).

const state = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: state.user }),
  requireOwner: async () => ({ id: state.user }),
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("server-only", () => ({}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }))

import { closeWorkspace } from "@/actions/cloud"
import { savePlan } from "@/actions/owner"
import { CloudStrip } from "@/components/thread/cloud-strip"
import { ToolCall, WorkspaceDetails, type ToolPart } from "@/components/thread/tool-call"
import { getThreadWorkspace, type ThreadWorkspace } from "@/queries/cloud"

import { createUser } from "../db/harness"
import { cloudDb } from "./db"

let db: Awaited<ReturnType<typeof cloudDb>>

beforeAll(async () => {
  db = await cloudDb()
  state.user = db.user
})

const strip = (over: Partial<ThreadWorkspace>) =>
  renderToStaticMarkup(
    createElement(CloudStrip, {
      workspace: {
        id: "00000000-0000-4000-8000-000000000001",
        repo: "acme/web",
        baseRef: "main",
        shortSha: "a1b2c3d",
        status: "paused",
        changes: { files: 3, added: 24, removed: 6 },
        error: null,
        closing: false,
        saved: true,
        usedMinutes: 42,
        limitMinutes: 300,
        ...over,
      },
    })
  )

const part = (name: string, extra: Record<string, unknown>) =>
  ({ type: `tool-${name}`, toolCallId: "c1", ...extra }) as unknown as ToolPart

const card = (p: ToolPart) => renderToStaticMarkup(createElement(ToolCall, { part: p }))

const details = (name: string, input: object, output: object | null) =>
  renderToStaticMarkup(
    createElement(WorkspaceDetails, {
      name,
      input: input as Record<string, unknown>,
      output: output as Record<string, unknown> | null,
    })
  )

describe("CT-UI-01: the workspace strip", () => {
  it("says where it is and each status in words, never internal terms", () => {
    const paused = strip({})
    expect(paused).toContain("acme/web · main @ a1b2c3d")
    expect(paused).toContain("3 files changed")
    expect(paused).toContain("Paused")
    expect(strip({ status: "running" })).toContain("Working")
    expect(strip({ status: "failed", error: "the repository is too large" })).toContain(
      "Couldn&#x27;t start"
    )
    expect(strip({ closing: true })).toContain("Closing…")
    expect(strip({ status: "starting" })).toContain("Starting")
    expect(strip({ repo: null, baseRef: null, shortSha: null })).toContain(
      "Blank project"
    )
    for (const html of [paused, strip({ status: "running" })]) {
      expect(html).not.toMatch(/sandbox|provider|runner|generation/i)
    }
  })

  it("reads the thread's open workspace only, under the person's own rows", async () => {
    const t = await db.task("ui01")
    expect(await getThreadWorkspace(db.user, t.threadId)).toBeNull()
    await db.pg.query(
      `insert into kriya.workspaces (user_id, thread_id, repo, base_ref, base_sha, provider, image, size, status, changes)
       values ($1, $2, 'acme/web', 'main', $3, 'local', 'kriya-runner:test', '2c-4g', 'paused', '{"files":2,"added":5,"removed":1}')`,
      [db.user, t.threadId, "a".repeat(40)]
    )
    expect(await getThreadWorkspace(db.user, t.threadId)).toMatchObject({
      repo: "acme/web",
      shortSha: "aaaaaaa",
      status: "paused",
      changes: { files: 2, added: 5, removed: 1 },
      closing: false,
      limitMinutes: 600,
    })
    const stranger = await createUser(db.pg)
    expect(await getThreadWorkspace(stranger, t.threadId)).toBeNull()
  })
})

describe("CT-UI-02: workspace tool cards", () => {
  it("collapsed: the command with its exit code and time; changes with counts", () => {
    const run = card(
      part("workspace_run", {
        state: "output-available",
        input: { command: "npm test" },
        output: {
          exitCode: 0,
          timedOut: false,
          durationMs: 14_000,
          stdout: "",
          stderr: "",
        },
      })
    )
    expect(run).toContain("$ npm test · ✓ exit 0 · 14 s")
    const failed = card(
      part("workspace_run", {
        state: "output-available",
        input: { command: "npm test" },
        output: {
          exitCode: 1,
          timedOut: false,
          durationMs: 2_500,
          stdout: "",
          stderr: "",
        },
      })
    )
    expect(failed).toContain("✗ exit 1 · 2.5 s")
    const changes = card(
      part("workspace_changes", {
        state: "output-available",
        input: {},
        output: {
          files: [
            { path: "a.ts", added: 20, removed: 4 },
            { path: "b.ts", added: 4, removed: 2 },
          ],
        },
      })
    )
    expect(changes).toContain("2 files changed, +24 −6")
    expect(
      card(
        part("workspace_open", {
          state: "output-available",
          input: { repo: "acme/web" },
          output: {
            repo: "acme/web",
            ref: "main",
            baseSha: "a1b2c3d4e5",
            restored: true,
          },
        })
      )
    ).toContain("restored from the last save")
  })

  it("a running command shows as running, with its latest output", () => {
    const live = card(
      part("workspace_run", {
        state: "output-available",
        preliminary: true,
        input: { command: "npm test" },
        output: { status: "running", tail: "PASS a.test.ts" },
      })
    )
    expect(live).not.toContain('aria-label="done"')
    expect(
      details(
        "workspace_run",
        { command: "npm test" },
        { status: "running", tail: "PASS a.test.ts" }
      )
    ).toContain("PASS a.test.ts")
  })

  it("expanded: output as text, never HTML; edits as marked lines; errors in words", () => {
    const html = details(
      "workspace_run",
      { command: "cat page.html" },
      {
        exitCode: 0,
        durationMs: 10,
        stdout: "<script>alert(1)</script>",
        stderr: "",
        truncated: true,
      }
    )
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain("Full log saved in the workspace.")
    const edit = details(
      "workspace_edit",
      { path: "a.ts", oldText: "return a + b", newText: "return a * b" },
      { path: "a.ts", replacements: 1 }
    )
    expect(edit).toContain("-return a + b")
    expect(edit).toContain("+return a * b")
    expect(
      details("workspace_read", { path: "a.ts" }, { error: "No such file." })
    ).toContain("No such file.")
    // The model's untrusted-content notice isn't shown to the person
    expect(
      details(
        "workspace_read",
        { path: "a.ts" },
        { notice: "UNTRUSTED NOTICE", text: "x" }
      )
    ).not.toContain("UNTRUSTED NOTICE")
    const published = details(
      "workspace_publish",
      {},
      {
        repo: "acme/web",
        number: 12,
        url: "https://github.com/acme/web/pull/12",
        verification: { status: "verified" },
      }
    )
    expect(published).toContain("https://github.com/acme/web/pull/12")
    expect(published).toContain("Checked on GitHub: the draft pull request is open.")
    expect(
      details("workspace_publish", {}, { url: "javascript:alert(1)", number: 1 })
    ).not.toContain("javascript:")
  })
})

describe("CT-UI-03: the publish approval card", () => {
  it("shows the repository, the new branch, the title and what happens", () => {
    const html = card(
      part("workspace_publish", {
        state: "approval-requested",
        approval: { id: "ap1" },
        input: {
          repo: "acme/web",
          changeSetId: "f".repeat(64),
          branch: "kriya/fix-date",
          title: "Fix date parsing",
          body: "Dates were parsed as UTC.",
        },
      })
    )
    expect(html).toContain("needs your ok")
    expect(html).toContain("acme/web")
    expect(html).toContain("kriya/fix-date")
    expect(html).toContain("Fix date parsing")
    expect(html).toContain("Dates were parsed as UTC.")
    expect(html).toContain(
      "Kriya will create this branch and a draft pull request on GitHub as you. Nothing is merged."
    )
    expect(html).not.toContain("f".repeat(64))
    expect(html).toContain("Approve")
    expect(html).toContain("Decline")
  })
})

describe("CT-UI-04: the person's close and the owner's plan field", () => {
  it("closeWorkspace asks once, for the person's own workspace only", async () => {
    const t = await db.task("ui04")
    const { rows } = await db.pg.query<{ id: string }>(
      `insert into kriya.workspaces (user_id, thread_id, provider, image, size, status)
       values ($1, $2, 'local', 'kriya-runner:test', '2c-4g', 'paused') returning id`,
      [db.user, t.threadId]
    )
    const stranger = await createUser(db.pg)
    state.user = stranger
    expect(await closeWorkspace(rows[0].id)).toEqual({ error: "Workspace not found." })
    state.user = db.user
    expect(await closeWorkspace("not-a-uuid")).toEqual({ error: "Workspace not found." })
    expect(await closeWorkspace(rows[0].id)).toEqual({ ok: true })
    expect(await closeWorkspace(rows[0].id)).toEqual({ error: "Workspace not found." })
    const row = (
      await db.pg.query<{ close_requested_at: Date | null; status: string }>(
        "select close_requested_at, status from kriya.workspaces where id = $1",
        [rows[0].id]
      )
    ).rows[0]
    expect(row.close_requested_at).not.toBeNull()
    expect(row.status).toBe("paused")
  })

  it("savePlan stores cloud minutes and refuses out of range", async () => {
    const { rows } = await db.pg.query<Record<string, unknown>>(
      "select * from kriya.plans where id = 'free'"
    )
    const plan = rows[0]
    const form = (minutes: string) => {
      const f = new FormData()
      f.set("id", "free")
      f.set("name", String(plan.name))
      f.set("description", String(plan.description ?? ""))
      f.set("priceRupees", "")
      f.set("includedRupees", String(Number(plan.included_usage_micro_inr) / 1_000_000))
      f.set("markupBps", String(plan.markup_bps))
      f.set("maxAgents", String(plan.max_agents))
      f.set("maxConcurrentTasks", String(plan.max_concurrent_tasks))
      f.set("maxTasksPerDay", String(plan.max_tasks_per_day))
      f.set("maxTaskSeconds", String(plan.max_task_seconds))
      f.set("maxSteps", String(plan.max_steps))
      f.set("maxTaskCostCents", String(Number(plan.max_task_cost_micro_usd) / 10_000))
      f.set("workspaceMinutes", minutes)
      for (const tier of plan.allowed_tiers as string[]) f.append("allowedTiers", tier)
      f.set("overageCapRupees", "0")
      f.set("warnAtPct", String(plan.warn_at_pct))
      f.set("active", "on")
      f.set("razorpayPlanId", "")
      return f
    }
    expect(await savePlan(null, form("120"))).toMatchObject({
      message: expect.any(String),
    })
    expect(
      (await db.pg.query("select workspace_minutes from kriya.plans where id = 'free'"))
        .rows
    ).toEqual([{ workspace_minutes: 120 }])
    expect(await savePlan(null, form("100001"))).toMatchObject({
      error: expect.stringContaining("workspaceMinutes"),
    })
  })
})
