import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

// N11 golden jobs with the track-N switches on (NSC-01, NSC-19): the operator's
// OG-01 and OG-06 assertions still hold, and what "delivered" means for a task
// is kept apart from when a job is done: drafts read back are a delivered task,
// but the job completes only when the person marks the invoices paid.

const ctx = vi.hoisted(() => ({ user: "" }))
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: ctx.user, email: null }),
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))
vi.mock(
  "@/lib/connectors",
  async (original) => (await import("./mocks")).connectors(await original()) as never
)
vi.mock(
  "@/lib/models",
  async (original) => (await import("./mocks")).modelMock(await original()) as never
)
vi.mock("@/lib/mcp/fetch", async (original) => {
  const { fixtureFetch } = await import("../../fixtures/mcp/server")
  return {
    ...(await original<typeof import("@/lib/mcp/fetch")>()),
    guardedFetch: (server: { url: string }) => fixtureFetch(server),
  }
})
vi.mock(
  "@/lib/mcp/registry",
  async (original) => (await import("./mocks")).registryMock(await original()) as never
)

import { approveMandate } from "@/actions/mandates"
import { reviewCrews } from "@/lib/operator/crews"
import { reviewMandates } from "@/lib/operator/loop"
import { operatorMetrics } from "@/lib/operator/metrics"
import { fillPlaybook, PLAYBOOKS } from "@/lib/operator/playbooks"

import { asUser } from "../../db/harness"
import { fixtureHosts, registerFixture, startMcpFixture } from "../../fixtures/mcp/server"
import {
  call,
  model,
  overdueInvoice,
  say,
  switches,
  world,
  type World,
} from "../../operator/golden/harness"
import { delivery } from "./harness"
import { reset, seen } from "./mocks"

const A = "asha@example.com"
const B = "ravi@example.com"
const playbook = (id: string) => PLAYBOOKS.find((p) => p.id === id)!

const NEXT = {
  KRIYA_NEXT_DELIVERY: "on",
  KRIYA_NEXT_RECHECK: "on",
  KRIYA_NEXT_RELIABILITY: "on",
  KRIYA_NEXT_MCP: "on",
  KRIYA_AGENTS_MEMORY_V2: "on",
}
const nextSwitches = (on: boolean) => {
  for (const [key, value] of Object.entries(NEXT)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

let fixture: Awaited<ReturnType<typeof startMcpFixture>>
let w: World
beforeAll(async () => {
  fixture = await startMcpFixture()
  fixtureHosts.set("tracker.fixture.example", fixture.url)
})
afterAll(() => fixture.close())

beforeEach(async () => {
  reset()
  fixture.state.calls.length = 0
  w = await world()
  ctx.user = w.user
  nextSwitches(true)
})
afterEach(() => {
  nextSwitches(false)
  switches(false)
  model.script = () => say("Done.")
})

describe("NG-01 NSC-01: remind the clients whose invoices are overdue", () => {
  it("OG-01 holds with next.* on; the drafts are a delivered task, the job completes only when invoices are paid", async () => {
    const invoices = [await overdueInvoice(w, 1), await overdueInvoice(w, 2)]
    model.script = (prompt, results) =>
      prompt.includes("[propose]") && results === 0
        ? call(
            "mandate_propose",
            fillPlaybook(playbook("OP-COLLECT"), { invoices, emails: [A, B] }),
            "p1"
          )
        : say("Proposed. Review it in your Inbox.")
    await w.turn("[propose] Please take this on")
    const [{ id }] = await w.q<{ id: string }>(
      "select id from kriya.mandates where status = 'proposed'"
    )
    const approved = await approveMandate(id)
    if (!("goalId" in approved)) throw new Error(approved.error)

    model.script = (prompt, results) =>
      !prompt.includes("Start the job")
        ? say("Done.")
        : results === 0
          ? call("gmail_draft", { to: [A], subject: "Invoice INV/1", body: "Hi" }, "d-a")
          : results === 1
            ? call(
                "gmail_draft",
                { to: [B], subject: "Invoice INV/2", body: "Hi" },
                "d-b"
              )
            : say("Both reminder drafts are saved in Gmail for you to send.")
    await w.fire(approved.goalId, "once")

    // The grant answered both drafts: no ask, two uses, pinned recipients only
    expect(seen.drafts.map((d) => d.to)).toEqual([[A], [B]])
    expect(await w.q("select * from kriya.approvals")).toEqual([])
    expect(await w.q("select uses from kriya.grants")).toEqual([{ uses: 2 }])

    // The task that made them is delivered; the job is not done
    const [goal] = await w.q<{ thread_id: string }>(
      "select thread_id from kriya.goals where id = $1",
      [approved.goalId]
    )
    const task = (await delivery(w, goal.thread_id))!
    expect(task.status).toBe("delivered")
    expect(task.episode.done.map((d) => d.tool)).toEqual(["gmail_draft", "gmail_draft"])
    await reviewMandates()
    expect((await w.job(id)).status).toBe("active")

    // Only the person marks an invoice paid; then Kriya, not the model, completes it
    await w.q("update kriya.invoices set status = 'paid'")
    await reviewMandates()
    const done = await w.job(id)
    expect(done.status).toBe("completed")
    expect((done.verdict as { met: boolean }[]).every((r) => r.met)).toBe(true)
    const metrics = await operatorMetrics(1)
    expect(metrics.om7).toEqual({ duplicates: 0 })
    expect(metrics.om3).toMatchObject({ outsidePins: 0, granted: 2 })
  })
})

describe("NG-19 NSC-19: a two-member crew, an app read, the same job", () => {
  it("OG-06 holds: drafts under the grant in the part's thread, one join, verdict met; an app read quarantines a note", async () => {
    await registerFixture(w.q, "tracker", [{ name: "search_items", risk: "R0" }])
    await asUser(w.pg, w.user, (tx) =>
      tx.query(
        "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
        [w.user]
      )
    )
    for (const [id, name] of [
      ["a2", "Ravi"],
      ["a3", "Mira"],
    ])
      await w.q(
        "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, $3, 'r', 'g')",
        [id, w.user, name]
      )
    await w.q("insert into kriya.squads (id, user_id, name) values ('s1', $1, 'Desk')", [
      w.user,
    ])
    for (const [position, agent] of ["a1", "a2", "a3"].entries())
      await w.q(
        "insert into kriya.squad_members (squad_id, agent_id, user_id, position) values ('s1', $1, $2, $3)",
        [agent, w.user, position]
      )
    await w.q(
      "insert into kriya.threads (id, user_id, squad_id) values ('sq', $1, 's1')",
      [w.user]
    )
    const invoices = [await overdueInvoice(w, 1), await overdueInvoice(w, 2)]
    const proposal = fillPlaybook(playbook("OP-COLLECT"), { invoices, emails: [A, B] })
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

    const range = { from: "2026-01-01", to: "2026-12-31" }
    model.script = (prompt, results) =>
      prompt.includes("Start the job")
        ? results === 0
          ? call(
              "crew_dispatch",
              {
                parts: [
                  {
                    key: "reminders",
                    agentId: "a2",
                    brief: "[part:reminders] A reminder draft to each client",
                  },
                  {
                    key: "ledger",
                    agentId: "a3",
                    brief: "[part:ledger] Which of the two invoices are unpaid",
                  },
                ],
              },
              "c1"
            )
          : say("Ravi and Mira are on it.")
        : prompt.includes("[part:reminders]")
          ? results === 0
            ? call("gmail_draft", { to: [A], subject: "INV/1", body: "Hi" }, "d-a")
            : results === 1
              ? call("gmail_draft", { to: [B], subject: "INV/2", body: "Hi" }, "d-b")
              : say("Both reminder drafts are saved.")
          : prompt.includes("[part:ledger]")
            ? results === 0
              ? call("ledger_list", range, "l1")
              : say("INV/1 and INV/2 are still unpaid.")
            : prompt.includes("crew's results are in") && results === 0
              ? call("mandate_report", {}, "r1")
              : say("Both drafts are ready; the invoices aren't paid yet.")
    await w.fire(approved.goalId, "once")
    while (await w.runQueued());
    expect(seen.drafts.map((d) => d.to)).toEqual([[A], [B]])
    expect(await w.q("select * from kriya.approvals")).toEqual([])
    const [reminders] = await w.q<{ thread_id: string }>(
      "select thread_id from kriya.crew_parts where key = 'reminders'"
    )
    expect(
      await w.q(
        `select t.thread_id from kriya.tool_executions x join kriya.tasks t on t.id = x.task_id
         where x.grant_id is not null`
      )
    ).toEqual([reminders, reminders])

    await reviewCrews()
    await reviewCrews()
    while (await w.runQueued());
    expect(await w.q("select status from kriya.crew_runs")).toEqual([
      { status: "joined" },
    ])
    await reviewMandates()
    expect(((await w.job(id)).verdict as { met: boolean }[])[0].met).toBe(true)
    await w.q("update kriya.invoices set status = 'paid'")
    await reviewMandates()
    expect((await w.job(id)).status).toBe("completed")

    // The same person, in the job's thread, reads the app and is asked to remember
    // something from it: the note waits for them (the app is outside content)
    model.script = (prompt, results) =>
      !prompt.includes("NOTE")
        ? say("Done.")
        : results === 0
          ? call("mcp_tracker_search_items", { query: "clients" }, "n1")
          : results === 1
            ? call("memory_write", { note: "Ravi prefers invoices on Mondays." }, "n2")
            : say("Saved.")
    await w.turn("NOTE what the tracker says about Ravi", "sq")
    expect(await w.q("select content, trust from kriya.memories")).toEqual([
      { content: "Ravi prefers invoices on Mondays.", trust: "unconfirmed" },
    ])
  })
})
