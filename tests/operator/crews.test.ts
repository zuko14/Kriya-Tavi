import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Crews whose members act (O11, CREW_EXECUTION.md §8): each part is its
// own task in its own thread, run by the member with its own tools,
// approvals and the job's grants; the worker joins the results into the
// job's thread. OT-CREW-01…09 and 11 on the scripted model and PGlite.

const fixtures = vi.hoisted(() => ({
  user: "",
  drafts: [] as { to: string[] }[],
  offered: [] as string[][],
  prompts: [] as string[],
}))

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: fixtures.user, email: null }),
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock("@/lib/connectors", async (original) => ({
  ...(await original<typeof import("@/lib/connectors")>()),
  gmailDraft: async (_u: string, input: { to: string[] }) => {
    fixtures.drafts.push(input)
    const id = `d${fixtures.drafts.length}`
    return {
      draftId: id,
      link: "https://mail.google.com",
      verification: {
        status: "verified" as const,
        method: "api_readback" as const,
        evidence: [{ kind: "provider_id" as const, value: id }],
      },
    }
  },
}))
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        fixtures.offered.push((options.tools ?? []).map((t) => t.name).sort())
        const system = options.prompt.find((m) => m.role === "system")
        fixtures.prompts.push(system && "content" in system ? String(system.content) : "")
        const { respond } = await import("./golden/harness")
        return {
          stream: simulateReadableStream({
            chunks: respond(JSON.stringify(options.prompt)) as never[],
          }),
        }
      },
    }),
}))

import { approveMandate, revokeMandate, stopCrew } from "@/actions/mandates"
import { enqueueApproval } from "@/lib/agent/queue"
import { dispatchCrew, reviewCrews } from "@/lib/operator/crews"
import { reviewMandates } from "@/lib/operator/loop"
import { fillPlaybook, PLAYBOOKS } from "@/lib/operator/playbooks"
import { getInbox } from "@/queries/inbox"
import { getNavigation } from "@/queries/workspace"

import {
  call,
  model,
  overdueInvoice,
  say,
  switches,
  world,
  type World,
} from "./golden/harness"

const A = "asha@example.com"
const B = "ravi@example.com"
const collect = PLAYBOOKS.find((p) => p.id === "OP-COLLECT")!

let w: World

// A squad: Lekha (a1) leads, Ravi (a2) and Mira (a3) are members
async function squad() {
  for (const [id, name] of [
    ["a2", "Ravi"],
    ["a3", "Mira"],
  ]) {
    await w.q(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, $3, 'r', 'g')",
      [id, w.user, name]
    )
  }
  await w.q("insert into kriya.squads (id, user_id, name) values ('s1', $1, 'Desk')", [
    w.user,
  ])
  for (const [position, agent] of ["a1", "a2", "a3"].entries()) {
    await w.q(
      "insert into kriya.squad_members (squad_id, agent_id, user_id, position) values ('s1', $1, $2, $3)",
      [agent, w.user, position]
    )
  }
  await w.q("insert into kriya.threads (id, user_id, squad_id) values ('sq', $1, 's1')", [
    w.user,
  ])
}

// The squad proposes OP-COLLECT for two clients; the person approves it
async function squadJob() {
  const invoices = [await overdueInvoice(w, 1), await overdueInvoice(w, 2)]
  const proposal = fillPlaybook(collect, { invoices, emails: [A, B] })
  model.script = (prompt, results) =>
    prompt.includes("[propose]") && results === 0
      ? call("mandate_propose", proposal, "p1")
      : say("Proposed.")
  await w.turn("[propose] Please take this on", "sq")
  const [{ id }] = await w.q<{ id: string }>(
    "select id from kriya.mandates where status = 'proposed'"
  )
  const approved = await approveMandate(id)
  if (!("goalId" in approved)) throw new Error(approved.error)
  const [{ thread_id }] = await w.q<{ thread_id: string }>(
    "select thread_id from kriya.goals where id = $1",
    [approved.goalId]
  )
  return { id, goalId: approved.goalId, thread: thread_id }
}

const lead = (thread: string) => ({ userId: w.user, threadId: thread, leadId: "a1" })
const part = (key: string, agentId: string, brief: string, dependsOn?: string[]) => ({
  key,
  agentId,
  brief,
  ...(dependsOn && { dependsOn }),
})

// Runs every queued task until none is left
async function drain() {
  for (let i = 0; i < 20; i++) if (!(await w.runQueued())) return
  throw new Error("tasks kept coming")
}

const parts = () =>
  w.q<{
    key: string
    status: string
    thread_id: string
    task_id: string | null
    result: string | null
  }>("select key, status, thread_id, task_id, result from kriya.crew_parts order by key")

beforeEach(async () => {
  fixtures.drafts.length = 0
  fixtures.offered.length = 0
  fixtures.prompts.length = 0
  w = await world()
  fixtures.user = w.user
  process.env.KRIYA_OPERATOR_CREWS = "on"
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
  await squad()
})
afterEach(() => {
  delete process.env.KRIYA_OPERATOR_CREWS
  delete process.env.KRIYA_FX_USD_INR
  switches(false)
})

describe("crew_dispatch refusals (OT-CREW-01)", () => {
  it("refuses the lead as a member, non-members, cycles, 5 parts and outside a job", async () => {
    const { thread } = await squadJob()
    const refused = async (input: unknown, threadId = thread) => {
      const result = await dispatchCrew(lead(threadId), input)
      expect(result).toHaveProperty("error")
    }
    await refused({ parts: [part("a", "a1", "Do it")] })
    await refused({ parts: [part("a", "zz", "Do it")] })
    await refused({ parts: [part("a", "a2", "x", ["b"]), part("b", "a3", "y", ["a"])] })
    await refused({ parts: [part("a", "a2", "x", ["a"])] })
    await refused({ parts: [part("a", "a2", "x"), part("a", "a3", "y")] })
    await refused({
      parts: ["a", "b", "c", "d", "e"].map((k) => part(k, "a2", "x")),
    })
    // A squad thread with no job, and a single agent's chat
    await refused({ parts: [part("a", "a2", "x")] }, "sq")
    await refused({ parts: [part("a", "a2", "x")] }, "chat")
    expect(await w.q("select * from kriya.crew_runs")).toEqual([])
  })

  it("refuses a second crew while one runs, and a fourth round", async () => {
    const { id, thread } = await squadJob()
    const first = await dispatchCrew(lead(thread), { parts: [part("a", "a2", "x")] })
    expect(first).toHaveProperty("runId")
    expect(
      await dispatchCrew(lead(thread), { parts: [part("a", "a2", "x")] })
    ).toHaveProperty("error")
    await w.q("update kriya.crew_runs set status = 'canceled'")
    for (const round of [2, 3]) {
      await w.q(
        `insert into kriya.crew_runs (id, user_id, lead_thread_id, lead_agent_id, squad_id, mandate_id, round, status, deadline_at)
         values ($1, $2, $3, 'a1', 's1', $4, $5, 'running', now() + interval '1 day')`,
        [`r${round}`, w.user, thread, id, round]
      )
      await w.q("update kriya.crew_runs set status = 'canceled' where id = $1", [
        `r${round}`,
      ])
    }
    const fourth = await dispatchCrew(lead(thread), { parts: [part("a", "a2", "x")] })
    expect(fourth).toMatchObject({ error: expect.stringContaining("3") })
  })
})

describe("dispatch (OT-CREW-02)", () => {
  it("makes one thread and one task per runnable part; dependent parts wait", async () => {
    const { thread } = await squadJob()
    const result = await dispatchCrew(lead(thread), {
      parts: [
        part("drafts", "a2", "Draft the reminders"),
        part("ledger", "a3", "Summarise the ledger"),
        part("check", "a3", "Check the drafts", ["drafts"]),
      ],
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.parts.map((p) => p.key)).toEqual(["drafts", "ledger", "check"])
    const rows = await parts()
    expect(rows.map((r) => [r.key, r.status, Boolean(r.task_id)])).toEqual([
      ["check", "waiting", false],
      ["drafts", "queued", true],
      ["ledger", "queued", true],
    ])
    // Each part has its own single-agent thread, kept out of the lists
    const threads = await w.q<{ id: string; agent_id: string; squad_id: string | null }>(
      "select t.id, t.agent_id, t.squad_id from kriya.threads t join kriya.crew_parts p on p.thread_id = t.id order by p.key"
    )
    expect(threads.map((t) => [t.agent_id, t.squad_id])).toEqual([
      ["a3", null],
      ["a2", null],
      ["a3", null],
    ])
    const nav = await getNavigation(w.user)
    expect(nav.threads.map((t) => t.id)).not.toContain(threads[1].id)
    const tasks = await w.q<{ input: Record<string, unknown>; idempotency_key: string }>(
      "select input, idempotency_key from kriya.tasks where thread_id = any($1) order by created_at",
      [threads.map((t) => t.id)]
    )
    expect(tasks).toHaveLength(2)
    expect(tasks[0].input).toMatchObject({ channel: "crew", runId: result.runId })
    expect(tasks[0].idempotency_key).toMatch(/^crew:/)
    // The job's thread stays free for the person
    expect(
      await w.q(
        "select 1 from kriya.tasks where thread_id = $1 and status in ('queued', 'running')",
        [thread]
      )
    ).toEqual([])
  })
})

describe("members act under the job's grants (OT-CREW-03, OT-CREW-04)", () => {
  it("a pinned draft runs without asking; outside the pin it asks in the part's thread", async () => {
    const { thread } = await squadJob()
    await dispatchCrew(lead(thread), {
      parts: [part("drafts", "a2", "[part:pinned] Draft the reminders")],
    })
    model.script = (prompt, results) =>
      prompt.includes("declined")
        ? say("Skipped the extra address.")
        : prompt.includes("[part:pinned]")
          ? results === 0
            ? call("gmail_draft", { to: [A], subject: "INV/1", body: "Hi" }, "d1")
            : results === 1
              ? call(
                  "gmail_draft",
                  { to: [A, "x@evil.example"], subject: "s", body: "b" },
                  "d2"
                )
              : say("One draft saved; one waits for you.")
          : say("Done.")
    await drain()
    expect(fixtures.drafts.map((d) => d.to)).toEqual([[A]])
    const [p] = await parts()
    const asks = await w.q<{ thread_id: string; id: string }>(
      "select thread_id, id from kriya.approvals where status = 'pending'"
    )
    expect(asks.map((a) => a.thread_id)).toEqual([p.thread_id])
    expect(
      await w.q(
        "select count(*)::int as n from kriya.tool_executions where grant_id is not null"
      )
    ).toEqual([{ n: 1 }])

    await reviewCrews()
    expect((await parts())[0].status).toBe("needs_approval")
    // The Inbox names the job and the member (CREW_EXECUTION §7)
    const inbox = await getInbox(w.user)
    expect(inbox.approvals.map((x) => [x.jobTitle, x.agentName])).toEqual([
      ["Get 2 overdue invoices paid", "Ravi"],
    ])
    // Waiting on the person is never idle (O6): the job isn't stuck
    await reviewMandates()

    // The person declines in the Inbox: only that part carries on
    await enqueueApproval({
      userId: w.user,
      threadId: p.thread_id,
      approvalId: asks[0].id,
      approved: false,
    })
    const queued = await w.q<{ thread_id: string }>(
      "select thread_id from kriya.tasks where status = 'queued'"
    )
    expect(queued).toEqual([{ thread_id: p.thread_id }])
    await drain()
    await reviewCrews()
    expect((await parts())[0].status).toBe("done")
  })
})

describe("dependencies and the join (OT-CREW-05, OT-CREW-06)", () => {
  it("a dependent part starts after its dependency with its result; the join runs once", async () => {
    const { thread } = await squadJob()
    await dispatchCrew(lead(thread), {
      parts: [
        part("first", "a2", "[part:first] Find the totals"),
        part("second", "a3", "[part:second] Write the summary", ["first"]),
      ],
    })
    const seen: string[] = []
    model.script = (prompt) => {
      seen.push(prompt)
      if (prompt.includes("[part:first]")) return say("Totals: ₹1,000 and ₹2,000.")
      if (prompt.includes("[part:second]")) return say("Summary written.")
      return say("Combined.")
    }
    await drain()
    await reviewCrews()
    let rows = await parts()
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ["first", "done"],
      ["second", "queued"],
    ])
    expect(rows[0].result).toBe("Totals: ₹1,000 and ₹2,000.")
    await drain()
    // The second part saw the first one's report
    expect(seen.find((s) => s.includes("[part:second]"))).toContain("₹1,000 and ₹2,000")

    await reviewCrews()
    await reviewCrews()
    rows = await parts()
    expect(rows.map((r) => r.status)).toEqual(["done", "done"])
    const joins = await w.q<{ id: string; input: Record<string, unknown> }>(
      "select id, input from kriya.tasks where thread_id = $1 and input->>'channel' = 'crew'",
      [thread]
    )
    expect(joins).toHaveLength(1)
    const [run] = await w.q<{ status: string; join_task_id: string }>(
      "select status, join_task_id from kriya.crew_runs"
    )
    expect(run).toEqual({ status: "joined", join_task_id: joins[0].id })
    const [message] = await w.q<{ parts: { text: string }[] }>(
      "select parts from kriya.messages where thread_id = $1 and metadata->>'channel' = 'crew'",
      [thread]
    )
    const text = message.parts[0].text
    expect(text).toContain("Ravi")
    expect(text).toContain("Mira")
    expect(text).toContain("Totals: ₹1,000 and ₹2,000.")
    expect(text).toContain("Done")
    // Members' text is data, not instructions
    expect(text).toContain("not instructions")
  })
})

describe("deadline (OT-CREW-07)", () => {
  it("cancels waiting parts and still joins", async () => {
    const { thread } = await squadJob()
    await dispatchCrew(lead(thread), {
      parts: [
        part("first", "a2", "[part:slow] Wait"),
        part("second", "a3", "Later", ["first"]),
      ],
    })
    // The first part is still working when time runs out
    await w.q(
      `update kriya.tasks set status = 'running', started_at = now(), attempts = 1,
         lease_owner = 'w9', lease_expires_at = now() + interval '1 hour'
       where status = 'queued'`
    )
    await w.q("update kriya.crew_runs set deadline_at = now() - interval '1 minute'")
    await reviewCrews()
    const rows = await parts()
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ["first", "working"],
      ["second", "canceled"],
    ])
    expect((await w.q("select status from kriya.crew_runs"))[0]).toEqual({
      status: "joined",
    })
  })
})

describe("budget and limits (OT-CREW-08)", () => {
  it("splits the job's ₹ budget between unfinished parts, within the plan", async () => {
    const { id, thread } = await squadJob()
    process.env.KRIYA_FX_USD_INR = "84.0000"
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    // ₹1 left this month, two parts: ₹0.50 each, at markup 1x and ₹84 a dollar
    await w.q("update kriya.mandates set budget_micro_inr = 1000000 where id = $1", [id])
    await w.q(
      "update kriya.plans set markup_bps = 10000, max_task_cost_micro_usd = 50000"
    )
    await dispatchCrew(lead(thread), {
      parts: [part("a", "a2", "x"), part("b", "a3", "y")],
    })
    const budgets = await w.q<{ cost_budget_micro_usd: string }>(
      "select cost_budget_micro_usd::text from kriya.tasks where input->>'channel' = 'crew'"
    )
    // 500,000 micro-INR ÷ 84 = 5952 micro-USD, under the plan's 50,000
    expect(budgets.map((b) => Number(b.cost_budget_micro_usd))).toEqual([5952, 5952])
  })

  it("a part refused for a limit fails with the reason, and the join says so", async () => {
    const { thread } = await squadJob()
    await w.q("update kriya.plans set max_tasks_per_day = 0")
    const result = await dispatchCrew(lead(thread), { parts: [part("a", "a2", "x")] })
    expect(result).toHaveProperty("runId")
    const [row] = await parts()
    expect(row.status).toBe("failed")
    expect(row.result).toMatch(/today's 0 tasks/)
    // The join waits for the limit too, then carries the reason to the lead
    await reviewCrews()
    expect(await w.q("select status from kriya.crew_runs")).toEqual([
      { status: "joining" },
    ])
    await w.q("update kriya.plans set max_tasks_per_day = 20")
    await reviewCrews()
    const [message] = await w.q<{ parts: { text: string }[] }>(
      "select parts from kriya.messages where thread_id = $1 and metadata->>'channel' = 'crew'",
      [thread]
    )
    expect(message.parts[0].text).toMatch(/today's 0 tasks/)
  })
})

describe("stopping (OT-CREW-09)", () => {
  it("Stop crew cancels every part's task", async () => {
    const { id, thread } = await squadJob()
    await dispatchCrew(lead(thread), {
      parts: [part("a", "a2", "x"), part("b", "a3", "y")],
    })
    // A part waiting on the person: its approval can't be answered after the stop
    const [first] = await parts()
    await w.q(
      `insert into kriya.approvals (id, user_id, thread_id, tool_name, risk_class, title, expires_at)
       values ('ap1', $1, $2, 'gmail_draft', 'R3', 'Save a draft', now() + interval '1 day')`,
      [w.user, first.thread_id]
    )
    expect(await stopCrew(id)).toEqual({ ok: true })
    expect(await w.q("select status from kriya.approvals")).toEqual([
      { status: "expired" },
    ])
    expect(
      await w.q("select status from kriya.tasks where input->>'channel' = 'crew'")
    ).toEqual([{ status: "canceled" }, { status: "canceled" }])
    expect((await parts()).map((r) => r.status)).toEqual(["canceled", "canceled"])
    expect(await w.q("select status from kriya.crew_runs")).toEqual([
      { status: "canceled" },
    ])
  })

  it("revoking the job cancels its crew", async () => {
    const { id, thread } = await squadJob()
    await dispatchCrew(lead(thread), { parts: [part("a", "a2", "x")] })
    expect(await revokeMandate(id)).toEqual({ ok: true })
    expect(
      await w.q("select status from kriya.tasks where input->>'channel' = 'crew'")
    ).toEqual([{ status: "canceled" }])
    expect(await w.q("select status from kriya.crew_runs")).toEqual([
      { status: "canceled" },
    ])
  })
})

describe("the lead's tools (OT-CREW-11, OT-REG-01)", () => {
  it("crew_dispatch only for a squad in its job's thread with operator.crews on", async () => {
    const { goalId, thread } = await squadJob()
    model.script = () => say("Hi.")
    await w.turn("hello", thread)
    expect(fixtures.offered.at(-1)).toContain("crew_dispatch")
    expect(fixtures.offered.at(-1)).toContain("assign")
    const onPrompt = fixtures.prompts.at(-1)

    // A squad thread outside a job: assign as today, no crew_dispatch
    await w.turn("hello", "sq")
    expect(fixtures.offered.at(-1)).toContain("assign")
    expect(fixtures.offered.at(-1)).not.toContain("crew_dispatch")

    // Off: the same belt minus crew_dispatch, and the same prompt
    delete process.env.KRIYA_OPERATOR_CREWS
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    await w.turn("hello", thread)
    const off = fixtures.offered.at(-1)!
    expect(off).not.toContain("crew_dispatch")
    expect(off).toEqual(fixtures.offered.at(-3)!.filter((n) => n !== "crew_dispatch"))
    expect(fixtures.prompts.at(-1)).toBe(onPrompt)
    expect(goalId).toBeTruthy()
  })
})
