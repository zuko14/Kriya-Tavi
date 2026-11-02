import { spawnSync } from "node:child_process"

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { Agent } from "@/db/schema"
import { buildInstructions, type Capabilities } from "@/lib/agent/instructions"
import { FOREIGN } from "@/lib/agent/tools"
import {
  TaskWorkspace,
  type CloudSettings,
  type WorkspaceLine,
} from "@/lib/cloud/session"
import { createWorkspaceTools } from "@/lib/cloud/tools"

import type { TestDb } from "../db/harness"
import { cloudDb } from "./db"
import { FakeProvider, fixtureSource } from "./fake-provider"

// The workspace_* tools themselves (TOOLS_AND_CONTRACTS §3, TEST_STRATEGY
// CT-TOOL-*), on a real TaskWorkspace whose sandboxes are the in-process
// runner. Through runTask: tests/cloud/agent.test.ts.

const hasGit = spawnSync("git", ["--version"]).status === 0

const SETTINGS: CloudSettings = {
  image: "kriya-runner:test",
  size: "2c-4g",
  network: "registries",
  commandTimeoutSeconds: 60,
  maxRunning: 10,
  maxImportMb: 50,
  maxCheckpointMb: 10,
  costMicroUsdPerHour: null,
}

let db: Awaited<ReturnType<typeof cloudDb>>
let pg: TestDb
let provider: FakeProvider

beforeAll(async () => {
  db = await cloudDb()
  pg = db.pg
})
beforeEach(() => {
  provider = new FakeProvider()
})
afterEach(() => provider.closeAll())

// What the AI SDK passes to execute
type Options = { toolCallId: string; messages: never[]; abortSignal: AbortSignal }
const options = (): Options => ({
  toolCallId: "c1",
  messages: [],
  abortSignal: new AbortController().signal,
})

type AnyTool = {
  execute?: (input: never, options: Options) => unknown
  toModelOutput?: (o: { toolCallId: string; input: never; output: never }) => unknown
}

// The final result of a tool (a generator's last yield)
async function run(tool: unknown, input: unknown) {
  const result = (tool as AnyTool).execute!(input as never, options())
  if (
    result &&
    typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  ) {
    const all: unknown[] = []
    for await (const item of result as AsyncIterable<unknown>) all.push(item)
    return { final: all.at(-1) as Record<string, unknown>, all }
  }
  return { final: (await result) as Record<string, unknown>, all: [] }
}

const modelText = (tool: unknown, input: unknown, output: unknown) =>
  (
    (tool as AnyTool).toModelOutput!({
      toolCallId: "c1",
      input: input as never,
      output: output as never,
    }) as { value: string }
  ).value

async function belt(tag: string, repos = false) {
  const t = await db.task(tag)
  const { source } = fixtureSource()
  const workspace = new TaskWorkspace(provider, t, SETTINGS, { source })
  return { t, workspace, tools: createWorkspaceTools(workspace, { repos }) }
}

describe.skipIf(!hasGit)("workspace tools", () => {
  it("CT-TOOL-01: a repository needs GitHub; a second repository is refused", async () => {
    const off = await belt("t01a")
    const refused = await run(off.tools.workspace_open, { repo: "owner/calc" })
    expect(refused.final.error).toMatch(/GitHub/)
    expect(provider.calls).toEqual([])

    const on = await belt("t01b", true)
    const opened = await run(on.tools.workspace_open, { repo: "owner/calc" })
    expect(opened.final).toMatchObject({
      repo: "owner/calc",
      status: "running",
      restored: false,
    })
    const second = await run(on.tools.workspace_open, { repo: "owner/other" })
    expect(second.final.error).toMatch(/close it first/)
    // Bad names never reach the provider
    await expect(
      (
        on.tools.workspace_open.inputSchema as {
          parseAsync: (v: unknown) => Promise<unknown>
        }
      ).parseAsync({
        repo: "../etc",
      })
    ).rejects.toThrow()
    await on.workspace.close(null)
  })

  it("CT-TOOL-02: workspace_run streams its tail, then the model gets head and tail only", async () => {
    const { tools, workspace } = await belt("t02")
    await run(tools.workspace_open, {})
    const streamed = await run(tools.workspace_run, {
      command: "echo start; sleep 1.5; echo end",
    })
    expect(streamed.all.length).toBeGreaterThan(1)
    expect(streamed.all[0]).toMatchObject({ status: "running" })
    expect(
      streamed.all.some((r) => String((r as { tail?: string }).tail).includes("start"))
    ).toBe(true)
    expect(streamed.final).toMatchObject({ exitCode: 0, stdout: "start\nend\n" })

    const input = { command: "for i in $(seq 1 4000); do echo line-$i; done" }
    const big = await run(tools.workspace_run, input)
    expect(String(big.final.stdout).length).toBeGreaterThan(20_000)
    const text = modelText(tools.workspace_run, input, big.final)
    expect(text.length).toBeLessThan(10_000)
    expect(text).toContain("line-1\n")
    expect(text).toContain("line-4000")
    expect(text).toContain(String(big.final.logPath))
    await workspace.close(null)
  })

  it("CT-TOOL-03: the third identical command in a row carries a note (P5)", async () => {
    const { tools, workspace } = await belt("t03")
    await run(tools.workspace_open, {})
    const notes: unknown[] = []
    for (const command of ["echo hi", "echo hi", "echo hi", "echo other", "echo hi"]) {
      notes.push((await run(tools.workspace_run, { command })).final.note)
    }
    expect(notes.map(Boolean)).toEqual([false, false, true, false, false])
    expect(String(notes[2])).toMatch(/third time/)
    await workspace.close(null)
  })

  it("CT-TOOL-04: every output carries FOREIGN; refusals come back as errors", async () => {
    const { tools, workspace } = await belt("t04")
    const outputs = [
      await run(tools.workspace_open, {}),
      await run(tools.workspace_write, { path: "README.md", content: "# Hi\nneedle\n" }),
      await run(tools.workspace_read, { path: "README.md" }),
      await run(tools.workspace_edit, {
        path: "README.md",
        oldText: "Hi",
        newText: "Hello",
      }),
      await run(tools.workspace_patch, {
        patch: "*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch",
      }),
      await run(tools.workspace_list, {}),
      await run(tools.workspace_search, { pattern: "needle" }),
      await run(tools.workspace_changes, {}),
      await run(tools.workspace_run, { command: "cat README.md" }),
    ]
    for (const { final } of outputs) {
      expect(final.error, JSON.stringify(final)).toBeUndefined()
      expect(final.notice).toBe(FOREIGN)
    }
    expect(outputs[2].final.text).toBe("# Hi\nneedle\n")
    expect(outputs[7].final.files).toHaveLength(2)
    // The strip's counts follow workspace_changes
    const { rows } = await pg.query<{ changes: unknown }>(
      "select changes from kriya.workspaces where thread_id = 'thread-t04'"
    )
    expect(rows[0].changes).toEqual({ files: 2, added: 3, removed: 0 })

    const refused = await run(tools.workspace_read, { path: "../outside" })
    expect(refused.final.error).toMatch(/inside the workspace/)
    await run(tools.workspace_run, { command: "echo more >> README.md" })
    const stale = await run(tools.workspace_write, { path: "README.md", content: "x" })
    expect(stale.final.error).toMatch(/read it again/)
    await workspace.close(null)
  })

  it("CT-TOOL-04: a refusal to start (minutes) is an error the model can say", async () => {
    await pg.query("update kriya.plans set workspace_minutes = 0")
    const { tools } = await belt("t04b")
    expect((await run(tools.workspace_open, {})).final).toEqual({
      error: "This month's cloud workspace minutes are used up.",
    })
    expect((await run(tools.workspace_run, { command: "true" })).final.error).toBeTruthy()
    await pg.query("update kriya.plans set workspace_minutes = 600")
  })
})

describe("CT-TOOL-06: the prompt's workspace line", () => {
  const agent = { id: "a1", name: "Dev", role: "engineer", instructions: null } as Agent
  const caps = (workspace?: Capabilities["workspace"]): Capabilities => ({
    web: false,
    connected: { google: [], notion: false },
    writes: true,
    ...(workspace && { workspace }),
  })
  const line = (over: Partial<WorkspaceLine>): WorkspaceLine => ({
    repo: "owner/calc",
    baseRef: "main",
    baseSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    status: "paused",
    changes: { files: 3, added: 10, removed: 2 },
    lastActiveAt: new Date(),
    restored: false,
    ...over,
  })
  const prompt = (workspace?: Capabilities["workspace"]) =>
    buildInstructions(agent, caps(workspace), [], undefined)

  it("is absent without the switch: the prompt is today's", () => {
    expect(prompt()).not.toContain("Cloud workspace")
    expect(prompt()).not.toContain("workspace_")
  })

  it("says none, open, paused and restored as the row does", () => {
    expect(prompt({ line: null })).toMatch(/no workspace yet.*workspace_open/)
    const paused = prompt({ line: line({}) })
    expect(paused).toContain("owner/calc at a1b2c3d (main)")
    expect(paused).toContain("3 files changed")
    expect(paused).toContain("paused")
    expect(prompt({ line: line({ status: "running" }) })).toContain("open")
    expect(prompt({ line: line({ status: "running", restored: true }) })).toMatch(
      /restored from its last checkpoint/
    )
    expect(
      prompt({ line: line({ repo: null, baseSha: null, baseRef: null }) })
    ).toContain("a blank project")
    expect(paused).toMatch(/workspace_run result/)
  })
})
