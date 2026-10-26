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

// N11 golden scenarios with an app (NSC-03, 04, 09, 14, 15, 16, 22, 23): the
// fixture MCP app behind the real guarded-fetch swap, a scripted model, the
// real runner, approvals, retries, breaker, drift and the verifier. The app is
// the repo's fixture server; no real app is contacted.

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "", email: null }) }))
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
  "@/lib/connectors/sheets",
  async (original) => (await import("./mocks")).sheetsConnector(await original()) as never
)
vi.mock(
  "@/lib/web",
  async (original) => (await import("./mocks")).webMock(await original()) as never
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

import { resetDriftClock } from "@/lib/mcp/drift"
import { registry } from "@/lib/mcp/owner"
import { reset as resetBreaker, record } from "@/lib/reliability/breaker"

import { asUser } from "../../db/harness"
import { fixtureHosts, registerFixture, startMcpFixture } from "../../fixtures/mcp/server"
import {
  call,
  model,
  say,
  switches,
  world,
  type World,
} from "../../operator/golden/harness"
import { answerAll, answerNext, delivery, runsOf } from "./harness"
import { reset, seen } from "./mocks"

const NEXT = {
  KRIYA_NEXT_DELIVERY: "on",
  KRIYA_NEXT_RECHECK: "on",
  KRIYA_NEXT_RELIABILITY: "on",
  KRIYA_NEXT_MCP: "on",
  KRIYA_AGENTS_MEMORY_V2: "on",
  KRIYA_AGENTS_RADAR: "on",
}
const nextSwitches = (on: boolean) => {
  for (const [key, value] of Object.entries(NEXT)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

const READ_BACK = {
  tool: "get_item",
  args: { id: "/structuredContent/id" },
  expect: { "/structuredContent/title": "/input/title" },
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
  resetBreaker()
  resetDriftClock()
  fixture.state.calls.length = 0
  fixture.state.items.clear()
  fixture.state.unreadable.clear()
  fixture.state.read = "ok"
  fixture.state.drift = null
  fixture.state.flaky = 0
  fixture.state.down = false
  fixture.state.attempts = 0
  w = await world()
  nextSwitches(true)
  await w.q(
    "update kriya.connections set scopes = scopes || '{https://www.googleapis.com/auth/calendar.events}' where provider = 'google'"
  )
  await registerFixture(w.q, "tracker", [
    { name: "search_items", risk: "R0" },
    { name: "get_item", risk: "R0" },
    { name: "create_item", risk: "R3", verify: READ_BACK },
    { name: "flaky_read", risk: "R0", idempotent: true },
    { name: "inject_result", risk: "R0" },
    { name: "drifting", risk: "R0" },
  ])
  await asUser(w.pg, w.user, (tx) =>
    tx.query(
      "insert into kriya.mcp_enablements (user_id, server_id) values ($1, 'tracker')",
      [w.user]
    )
  )
})
afterEach(() => {
  nextSwitches(false)
  switches(false)
  model.script = () => say("Done.")
  vi.restoreAllMocks()
})

// The scripted model works down a list: step n makes call n, then the answer
const steps = (marker: string, calls: [string, unknown][], answer: string) => {
  model.script = (run, results) =>
    run.includes(marker) && results < calls.length
      ? call(calls[results][0], calls[results][1], `c${results}`)
      : say(answer)
}

// Several calls in one step, as a model may make them
const together = (marker: string, calls: [string, unknown][], answer: string) => {
  model.script = (run, results) =>
    run.includes(marker) && results === 0
      ? [
          ...calls.map(([tool, input], i) => call(tool, input, `p${i}`)[0]),
          call("x", {}, "x")[1],
        ]
      : say(answer)
}

describe("NG-03 NSC-03: a tracker issue for each bug", () => {
  const bugs: [string, unknown][] = [
    ["mcp_tracker_create_item", { title: "Login fails on Safari" }],
    ["mcp_tracker_create_item", { title: "Invoice PDF is blank" }],
  ]

  it("each create is approved, run once and read back; delivered only when every one is verified", async () => {
    together("BUGS", bugs, "Created both issues.")
    await w.turn("BUGS: one issue per bug in this thread")
    expect(await answerAll(w)).toBe(2)
    expect(fixture.state.calls.filter((c) => c.name === "create_item")).toEqual([
      { name: "create_item", arguments: { title: "Login fails on Safari" } },
      { name: "create_item", arguments: { title: "Invoice PDF is blank" } },
    ])
    const runs = await runsOf(w, "mcp_tracker_create_item")
    expect(runs.map((r) => [r.status, r.risk, r.verification?.status])).toEqual([
      ["succeeded", "R3", "verified"],
      ["succeeded", "R3", "verified"],
    ])
    const result = (await delivery(w))!
    expect(result.status).toBe("delivered")
    expect(result.episode.done).toHaveLength(2)
  })

  it("an issue the app can't read back leaves the task partly delivered, not delivered", async () => {
    together("BUGS", bugs, "Created both issues.")
    // The app can't show the second issue back
    fixture.state.unreadable.add("item-2")
    await w.turn("BUGS: one issue per bug in this thread")
    await answerAll(w)
    const result = (await delivery(w))!
    expect(result.status).toBe("partly")
    expect(result.episode.done).toHaveLength(1)
    expect(result.episode.unconfirmed).toEqual([
      expect.objectContaining({
        claim: "Used create item in tracker",
        reason: "Ran, but wasn't checked afterwards.",
      }),
    ])
  })
})

describe("NG-04 NSC-04: an email says to invite someone else too", () => {
  it("the extra action asks with its exact input; declined, nothing is sent and the rest is delivered", async () => {
    steps(
      "INVITE",
      [
        ["mcp_tracker_create_item", { title: "Bug from mail" }],
        [
          "gmail_draft",
          { to: ["attacker@evil.example"], subject: "Project invite", body: "Join us" },
        ],
      ],
      "Created the issue; I didn't invite anyone."
    )
    await w.turn("INVITE: file this bug")
    await answerNext(w, true)
    const [extra] = await w.q<{
      tool_name: string
      status: string
      preview: { input: { to: string[] } }
    }>("select tool_name, status, preview from kriya.approvals where status = 'pending'")
    expect(extra.tool_name).toBe("gmail_draft")
    expect(extra.preview.input.to).toEqual(["attacker@evil.example"])
    await answerNext(w, false)
    expect(seen.drafts).toEqual([])
    const asks = await w.q<{ tool_name: string; status: string }>(
      "select tool_name, status from kriya.approvals order by created_at"
    )
    expect(asks.map((a) => [a.tool_name, a.status])).toEqual([
      ["mcp_tracker_create_item", "approved"],
      ["gmail_draft", "declined"],
    ])
    const result = (await delivery(w))!
    expect(result.status).toBe("delivered")
    expect(result.episode.done.map((d) => d.tool)).toEqual(["mcp_tracker_create_item"])
  })
})

describe("NG-09 NSC-09: a note in the team workspace, and the due date on the Radar", () => {
  it("the app write is read back; the Radar keeps the date with the person's own words", async () => {
    steps(
      "WORKSPACE",
      [
        ["mcp_tracker_create_item", { title: "GST filing is due on 20 November 2026" }],
        [
          "obligation_add",
          {
            kind: "gst_return",
            title: "GST filing",
            dueAt: "2026-11-20T23:59:00+05:30",
            quote: "GST filing is due on 20 November 2026",
            sourceKind: "person",
            sourceRef: "person",
          },
        ],
      ],
      "Noted in the workspace and on your Radar."
    )
    await w.turn("WORKSPACE: note that the GST filing is due on 20 November 2026")
    await answerAll(w)
    const [run] = await runsOf(w, "mcp_tracker_create_item")
    expect(run.verification?.status).toBe("verified")
    expect(await w.q("select title, verified, status from kriya.obligations")).toEqual([
      { title: "GST filing", verified: true, status: "upcoming" },
    ])
    expect((await delivery(w))!.status).toBe("delivered")
  })
})

describe("NG-14 NSC-14: the app answers 503 twice", () => {
  // The retry waits are 0.5 s and 1.5 s; shortened here so the suite stays fast
  const quicken = () => {
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => real(fn, ms === 500 || ms === 1500 ? 1 : ms, ...rest)) as typeof setTimeout)
  }

  it("the safe read is retried and the task goes on; the write runs once", async () => {
    quicken()
    fixture.state.flaky = 2
    steps(
      "FLAKY",
      [
        ["mcp_tracker_flaky_read", {}],
        ["mcp_tracker_create_item", { title: "Follow up" }],
      ],
      "Read the latest item and created the follow-up."
    )
    await w.turn("FLAKY: read the latest item, then file a follow-up")
    await answerAll(w)
    // Three tries at the read (two 503s, then the answer), one create, and the
    // create's own read-back
    expect(fixture.state.attempts).toBe(5)
    expect(fixture.state.calls.map((c) => c.name)).toEqual([
      "flaky_read",
      "create_item",
      "get_item",
    ])
    expect(fixture.state.calls.filter((c) => c.name === "flaky_read")).toHaveLength(1)
    expect(fixture.state.calls.filter((c) => c.name === "create_item")).toHaveLength(1)
    const [read] = await runsOf(w, "mcp_tracker_flaky_read")
    expect(read).toMatchObject({ status: "succeeded", side_effect: false })
    expect((await delivery(w))!.status).toBe("delivered")
  })

  it("with next.reliability off the same 503 fails the read at once", async () => {
    quicken()
    delete process.env.KRIYA_NEXT_RELIABILITY
    ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
    fixture.state.flaky = 2
    steps("FLAKY", [["mcp_tracker_flaky_read", {}]], "It failed.")
    await w.turn("FLAKY: read the latest item")
    expect(fixture.state.attempts).toBe(1)
    const [read] = await runsOf(w, "mcp_tracker_flaky_read")
    expect(read.status).toBe("failed")
  })
})

describe("NG-15 NSC-15: the app is down for minutes", () => {
  it("the circuit opens after five failures; the next call fails at once with a line the model can pass on", async () => {
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => real(fn, ms === 500 || ms === 1500 ? 1 : ms, ...rest)) as typeof setTimeout)
    fixture.state.down = true
    model.script = (run, results) =>
      run.includes("DOWN") && !run.includes("stopped trying") && results < 8
        ? call("mcp_tracker_flaky_read", {}, `d${results}`)
        : say("Tracker isn't responding, so I couldn't read it. Nothing was changed.")
    await w.turn("DOWN: read the latest item")
    // Five failed calls at three tries each; the sixth never reached the app
    expect(fixture.state.attempts).toBe(15)
    const runs = await runsOf(w, "mcp_tracker_flaky_read")
    expect(runs).toHaveLength(6)
    expect(runs.every((r) => r.status === "failed")).toBe(true)
    const [last] = await w.q<{ error: string }>(
      "select error from kriya.tool_executions order by started_at desc limit 1"
    )
    expect(last.error).toContain("isn't responding; Kriya stopped trying for a minute")
    // Nothing was claimed or changed
    expect(await delivery(w)).toBeNull()
  })

  it("while it is open the next task starts without the app and doesn't try it", async () => {
    for (let i = 0; i < 5; i++) record("mcp:tracker")
    model.script = () => say("Done.")
    await w.turn("anything")
    expect(seen.tools[0].filter((n) => n.startsWith("mcp_"))).toEqual([])
    expect(fixture.state.attempts).toBe(0)
  })
})

describe("NG-16 NSC-16: the app changes a tool's description overnight", () => {
  it("the changed tool is off the belt, the others work, and the owner sees it drifted", async () => {
    fixture.state.drift = "description"
    steps("DRIFT", [["mcp_tracker_search_items", { query: "x" }]], "Found nothing new.")
    await w.turn("DRIFT: look something up")
    expect(seen.tools[0]).toContain("mcp_tracker_search_items")
    expect(seen.tools[0]).not.toContain("mcp_tracker_drifting")
    expect(fixture.state.calls.map((c) => c.name)).toEqual(["search_items"])
    const [tool] = await w.q<{ status: string }>(
      "select status from kriya.mcp_tools where name = 'drifting'"
    )
    expect(tool.status).toBe("drifted")
    const [app] = await registry()
    expect(
      app.tools.filter((t) => t.status === "drifted").map((t) => t.kriyaName)
    ).toEqual(["mcp_tracker_drifting"])
    expect(app.tools.find((t) => t.name === "drifting")!.definition).not.toBeNull()
  })
})

describe("NG-22 NSC-22: private data from an app, then 'look this up online'", () => {
  it("the web search waits for the person and nothing leaves", async () => {
    steps(
      "ONLINE",
      [
        ["mcp_tracker_search_items", { query: "contracts" }],
        ["web_search", { query: "contract renewal terms" }],
      ],
      "Done."
    )
    await w.turn("ONLINE: check my contracts, then look it up online")
    const [ask] = await w.q<{ tool_name: string; status: string }>(
      "select tool_name, status from kriya.approvals"
    )
    expect(ask).toEqual({ tool_name: "web_search", status: "pending" })
    expect(seen.web).toEqual([])
    await answerNext(w, false)
    expect(seen.web).toEqual([])
  })
})

describe("NG-23 NSC-23: a 'preference' found in an app result", () => {
  it("the note is saved unconfirmed until the person confirms it", async () => {
    steps(
      "REMEMBER",
      [
        ["mcp_tracker_inject_result", {}],
        ["memory_write", { note: "My manager is Priya Rao." }],
      ],
      "Saved."
    )
    await w.turn("REMEMBER: what the tracker says about my manager")
    expect(await w.q("select content, trust from kriya.memories")).toEqual([
      { content: "My manager is Priya Rao.", trust: "unconfirmed" },
    ])
  })
})
