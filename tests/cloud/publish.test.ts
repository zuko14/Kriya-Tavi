import { spawnSync } from "node:child_process"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"
import { createWorkspaceTools } from "@/lib/cloud/tools"
import type { FileStore } from "@/lib/files"

import { cloudDb } from "./db"
import { FakeProvider, FIXTURE, memoryStore } from "./fake-provider"
import {
  BASE,
  connectGithub,
  importFixtures,
  publishFixtures,
  serveGithub,
} from "./github-fixtures"
import { packDirectory } from "./tar"

// workspace_publish end to end (CD-10, TEST_STRATEGY CT-PUB-01…05): a
// repository imported through githubTarball into the real runner, changed,
// and published as one tree commit and a draft pull request, all against
// GitHub fixtures. CT-PUB-06 (no retry after publishing) is in agent.test.ts.

const hasGit = spawnSync("git", ["--version"]).status === 0
const REPO = "owner/calc"

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
let provider: FakeProvider

beforeAll(async () => {
  db = await cloudDb()
  await connectGithub(db.user)
})
beforeEach(() => {
  provider = new FakeProvider()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await provider.closeAll()
})

type Tool = { execute: (input: unknown, options: unknown) => unknown }
const options = {
  toolCallId: "c1",
  messages: [],
  abortSignal: new AbortController().signal,
}
async function call(tool: unknown, input: unknown) {
  const result = (tool as Tool).execute(input, options)
  if (
    result &&
    typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  ) {
    let last: unknown
    for await (const item of result as AsyncIterable<unknown>) last = item
    return last as Record<string, unknown>
  }
  return (await result) as Record<string, unknown>
}

// A workspace opened from the fixture repository, with multiply fixed
// A memory store by default: a publish stops when its checkpoint can't be saved
async function changed(tag: string, store: FileStore = memoryStore().store) {
  const t = await db.task(tag)
  // The default source: githubTarball through lib/connectors (no fixture source)
  const workspace = new TaskWorkspace(provider, t, SETTINGS, { store })
  const tools = createWorkspaceTools(workspace, { repos: true, publish: true })
  serveGithub(importFixtures(REPO, packDirectory(FIXTURE)))
  expect(await call(tools.workspace_open, { repo: REPO })).toMatchObject({
    repo: REPO,
    ref: "main",
    baseSha: BASE,
    status: "running",
  })
  vi.unstubAllGlobals()
  await call(tools.workspace_read, { path: "src/math.js" })
  await call(tools.workspace_edit, {
    path: "src/math.js",
    oldText: "multiply(a, b) {\n  return a + b",
    newText: "multiply(a, b) {\n  return a * b",
  })
  const changes = await call(tools.workspace_changes, {})
  return { workspace, tools, changeSetId: changes.changeSetId as string }
}

const publish = (changeSetId: string, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  changeSetId,
  branch: "kriya/fix-multiply",
  title: "Fix multiply",
  body: "multiply added instead of multiplying.",
  ...over,
})

describe.skipIf(!hasGit)("workspace_publish", () => {
  it("CT-PUB-01: one tree commit on the base, a new kriya/ branch, a draft PR, verified", async () => {
    const { workspace, tools, changeSetId } = await changed("p01")
    const { calls, left } = serveGithub(publishFixtures(REPO, "kriya/fix-multiply"))
    const result = await call(tools.workspace_publish, publish(changeSetId))
    expect(result).toMatchObject({
      repo: REPO,
      number: 12,
      url: `https://github.com/${REPO}/pull/12`,
      branch: "kriya/fix-multiply",
      base: "main",
      verification: { status: "verified" },
    })
    expect(left()).toBe(0)
    const blob = calls.find((c) => c.url.endsWith("/git/blobs"))!.body as {
      content: string
    }
    expect(Buffer.from(blob.content, "base64").toString()).toContain("return a * b")
    expect(calls.find((c) => c.url.endsWith("/pulls"))!.body).toMatchObject({
      draft: true,
      base: "main",
    })
    await workspace.close(null)
  })

  it("CT-PUB-02: a change after approval is refused and nothing goes to GitHub", async () => {
    const { workspace, tools, changeSetId } = await changed("p02")
    await call(tools.workspace_run, { command: "echo more >> src/math.js" })
    const { calls } = serveGithub([])
    expect((await call(tools.workspace_publish, publish(changeSetId))).error).toMatch(
      /changed after you approved/
    )
    expect(calls).toEqual([])
    await workspace.close(null)
  })

  it("CD-13: the published change set is checkpointed right before GitHub is asked", async () => {
    const { store, objects } = memoryStore()
    const { workspace, tools, changeSetId } = await changed("p13", store)
    let storedFirst = false
    const { calls } = serveGithub(publishFixtures(REPO, "kriya/fix-multiply"))
    const write = store.write
    store.write = async (...args) => {
      storedFirst = calls.length === 0
      return write(...args)
    }
    await call(tools.workspace_publish, publish(changeSetId))
    expect(storedFirst).toBe(true)
    expect(objects.size).toBe(1)
    expect([...objects.values()][0].toString()).toContain("return a * b")
    // A refused publish (CT-PUB-02's case) stores nothing
    const refused = await changed("p13b", memoryStore().store)
    await call(refused.tools.workspace_run, { command: "echo more >> src/math.js" })
    serveGithub([])
    await call(refused.tools.workspace_publish, publish(refused.changeSetId))
    expect(
      (
        await db.pg.query(
          "select checkpoint_seq from kriya.workspaces where thread_id = 'thread-p13b'"
        )
      ).rows
    ).toEqual([{ checkpoint_seq: 0 }])
    await refused.workspace.close("shutdown")
    await workspace.close(null)
  })

  it("CT-PUB-04: only the workspace's own repository, checked before any request", async () => {
    const { workspace, tools, changeSetId } = await changed("p04")
    const { calls } = serveGithub([])
    expect(
      (await call(tools.workspace_publish, publish(changeSetId, { repo: "owner/other" })))
        .error
    ).toMatch(/owner\/calc/)
    expect(calls).toEqual([])
    await workspace.close(null)
  })

  it("CT-PUB-05: over the file limit is refused before any request", async () => {
    const { workspace, tools } = await changed("p05")
    await call(tools.workspace_run, {
      command: "mkdir -p many && for i in $(seq 1 301); do echo $i > many/$i.txt; done",
    })
    const changes = await call(tools.workspace_changes, {})
    const { calls } = serveGithub([])
    const result = await call(
      tools.workspace_publish,
      publish(changes.changeSetId as string)
    )
    expect(result.error).toMatch(/300 files/)
    expect(calls).toEqual([])
    await workspace.close(null)
  })

  it("a blank workspace has nothing to publish to; without cloud.publish there's no tool", async () => {
    const t = await db.task("p06")
    const workspace = new TaskWorkspace(provider, t, SETTINGS)
    const tools = createWorkspaceTools(workspace, { repos: true, publish: true })
    await call(tools.workspace_open, {})
    const changes = await call(tools.workspace_changes, {})
    expect(
      (await call(tools.workspace_publish, publish(changes.changeSetId as string))).error
    ).toMatch(/repository/)
    await workspace.close(null)
    expect(
      "workspace_publish" in
        createWorkspaceTools(workspace, { repos: true, publish: false })
    ).toBe(false)
  })
})
