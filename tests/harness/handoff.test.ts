import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// HT-HND-01…03 (H8, HD-11, API_AND_CONTRACTS §7): a handoff stores the
// patch as track C's checkpoint 0-1, opens a workspace row and a thread of
// the device's agent and enqueues one task; the worker's TaskWorkspace then
// restores exactly those bytes on the base commit. Every refusal happens
// before anything is stored. Pull returns the latest checkpoint's bytes
// with its digest and base commit, only for the person's own workspace.

vi.mock("server-only", () => ({}))
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  isGatewayConfigured: () => true,
}))

import * as handoffRoute from "@/app/api/harness/v1/handoff/route"
import * as checkpointRoute from "@/app/api/harness/v1/workspaces/[id]/checkpoint/route"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"
import { setFileStoreForTests } from "@/lib/files"
import { ErrorResponse, HandoffMeta, HandoffResponse } from "@/lib/harness/contract"

import {
  BASE_SHA,
  FakeProvider,
  fixtureSource,
  memoryStore,
  textOf,
} from "../cloud/fake-provider"
import type { TestDb } from "../db/harness"
import { deviceFor, harnessDb, harnessEnv, VERSION } from "./setup"

const hasGit = spawnSync("git", ["--version"]).status === 0

const ON = {
  KRIYA_HARNESS_HANDOFF: "on",
  KRIYA_CLOUD_WORKSPACES: "on",
  KRIYA_CLOUD_PROVIDER: "local",
  KRIYA_CLOUD_MAX_CHECKPOINT_MB: "1",
  OPENROUTER_DEFAULT_MODEL: "test/budget-model",
}

// The fixture repository's multiply() fixed, as `kriya handoff` builds it
const PATCH = Buffer.from(`diff --git a/src/math.js b/src/math.js
index 763b78e..b9a2f65 100644
--- a/src/math.js
+++ b/src/math.js
@@ -3,5 +3,5 @@ export function add(a, b) {
 }

 export function multiply(a, b) {
-  return a + b
+  return a * b
 }
`)

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const META = {
  repo: "owner/calc",
  baseRef: "main",
  baseSha: BASE_SHA,
  note: "Finish the tests",
  sha256: digest(PATCH),
  bytes: PATCH.length,
}

let pg: TestDb
let newUser: () => Promise<string>
let objects: Map<string, Buffer>

async function person({ github = true, agent = true } = {}) {
  const user = await newUser()
  const device = await deviceFor(pg, user)
  const agentId = `ag-${device.deviceId.slice(0, 8)}`
  if (agent) {
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Arjun', 'engineer', 'g')",
      [agentId, user]
    )
    await pg.query("update kriya.harness_devices set agent_id = $1 where id = $2", [
      agentId,
      device.deviceId,
    ])
  }
  if (github) {
    await pg.query(
      "insert into kriya.connections (id, user_id, provider, scopes, access_token) values ($1, $2, 'github', '{}', 'sealed')",
      [`gh-${device.deviceId.slice(0, 8)}`, user]
    )
  }
  return { user, agentId, ...device }
}

let ip = 0
function upload(
  token: string,
  meta: unknown = META,
  patch: Buffer | null = PATCH,
  extra: Record<string, string> = {}
) {
  const form = new FormData()
  form.set("meta", typeof meta === "string" ? meta : JSON.stringify(meta))
  if (patch) form.set("patch", new Blob([new Uint8Array(patch)]), "checkpoint.patch")
  return handoffRoute.POST(
    new Request("https://kriya.example/api/harness/v1/handoff", {
      method: "POST",
      headers: {
        "x-forwarded-for": `10.1.0.${++ip % 250}`,
        "x-kriya-harness": VERSION,
        authorization: `Bearer ${token}`,
        ...extra,
      },
      body: form,
    })
  )
}

const pull = (token: string, id: string) =>
  checkpointRoute.GET(
    new Request(`https://kriya.example/api/harness/v1/workspaces/${id}/checkpoint`, {
      headers: {
        "x-forwarded-for": `10.2.0.${++ip % 250}`,
        "x-kriya-harness": VERSION,
        authorization: `Bearer ${token}`,
      },
    })
  )

async function refused(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  expect(ErrorResponse.parse(await res.json()).error).toBe(error)
}

const countOf = async (sql: string, params: unknown[]) =>
  (await pg.query<{ n: number }>(`select count(*)::int as n ${sql}`, params)).rows[0].n

// Nothing stored and nothing created for this person
async function nothingFor(user: string) {
  expect(objects.size).toBe(0)
  expect(await countOf("from kriya.workspaces where user_id = $1", [user])).toBe(0)
  expect(await countOf("from kriya.threads where user_id = $1", [user])).toBe(0)
  expect(await countOf("from kriya.tasks where user_id = $1", [user])).toBe(0)
}

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
  await pg.query("update kriya.plans set workspace_minutes = 600")
})
beforeEach(() => {
  harnessEnv(ON)
  // One store per case, so "nothing stored" is checked on this case alone
  const memory = memoryStore()
  objects = memory.objects
  setFileStoreForTests(memory.store)
})
afterAll(() => setFileStoreForTests(undefined))

describe("HT-HND-01: a handoff makes a workspace with the checkpoint and one task", () => {
  it("stores checkpoint 0-1, the workspace row, the thread and one queued task", async () => {
    const a = await person()
    const res = await upload(a.token)
    expect(res.status).toBe(201)
    const body = HandoffResponse.parse(await res.json())
    expect(body.url).toBe(`https://kriya.example/a/${a.agentId}/${body.threadId}`)

    const path = `workspaces/${a.user}/${body.workspaceId}/0-1.patch`
    expect([...objects.keys()]).toEqual([path])
    expect(objects.get(path)?.equals(PATCH)).toBe(true)

    const { rows } = await pg.query(
      `select user_id, thread_id, agent_id, repo, base_ref, base_sha, provider, status,
              generation, provider_ref, checkpoint_path, checkpoint_sha256,
              checkpoint_bytes::int as checkpoint_bytes, checkpoint_seq
       from kriya.workspaces where id = $1`,
      [body.workspaceId]
    )
    expect(rows).toEqual([
      {
        user_id: a.user,
        thread_id: body.threadId,
        agent_id: a.agentId,
        repo: "owner/calc",
        base_ref: "main",
        base_sha: BASE_SHA,
        provider: "local",
        status: "new",
        generation: 0,
        provider_ref: null,
        checkpoint_path: path,
        checkpoint_sha256: META.sha256,
        checkpoint_bytes: PATCH.length,
        checkpoint_seq: 1,
      },
    ])

    const tasks = await pg.query<{ id: string; status: string; agent_id: string }>(
      "select id, status, agent_id from kriya.tasks where thread_id = $1",
      [body.threadId]
    )
    expect(tasks.rows).toEqual([
      { id: body.taskId, status: "queued", agent_id: a.agentId },
    ])
    const message = await pg.query<{ role: string; parts: { text: string }[] }>(
      "select role, parts from kriya.messages where thread_id = $1",
      [body.threadId]
    )
    expect(message.rows).toHaveLength(1)
    expect(message.rows[0].role).toBe("user")
    const text = message.rows[0].parts.map((p) => p.text).join("")
    expect(text).toContain("owner/calc on main")
    expect(text).toContain("workspace_open")
    expect(text).toContain("Finish the tests")

    expect(
      await countOf(
        "from kriya.resource_usage where user_id = $1 and task_id = $2 and kind = 'workspace_storage_bytes' and quantity = $3",
        [a.user, body.taskId, PATCH.length]
      )
    ).toBe(1)
  })

  it.skipIf(!hasGit)(
    "the worker's TaskWorkspace imports at baseSha and restores exactly the handed-off patch",
    async () => {
      process.env.KRIYA_WORKSPACE_SECRET = "s".repeat(43)
      const a = await person()
      const body = HandoffResponse.parse(await (await upload(a.token)).json())
      const provider = new FakeProvider()
      const { source, calls } = fixtureSource()
      const settings: CloudSettings = {
        image: "local",
        size: "2c-4g",
        network: "registries",
        commandTimeoutSeconds: 60,
        maxRunning: 10,
        maxImportMb: 50,
        maxCheckpointMb: 1,
        costMicroUsdPerHour: null,
      }
      const store = (await import("@/lib/files")).fileStore()
      const ws = new TaskWorkspace(
        provider,
        { id: body.taskId, userId: a.user, threadId: body.threadId, agentId: a.agentId },
        settings,
        { store, source }
      )
      try {
        expect(await ws.open({})).toMatchObject({
          repo: "owner/calc",
          baseSha: BASE_SHA,
          status: "running",
        })
        expect(calls).toEqual([{ repo: "owner/calc", ref: BASE_SHA }])
        expect(await textOf(await ws.client(), "src/math.js")).toContain("a * b")
      } finally {
        await ws.close(null)
        await provider.closeAll()
      }
    }
  )

  it("an empty patch hands off the base commit alone: no checkpoint stored", async () => {
    const a = await person()
    const empty = Buffer.alloc(0)
    const res = await upload(a.token, { ...META, sha256: digest(empty), bytes: 0 }, empty)
    expect(res.status).toBe(201)
    const body = HandoffResponse.parse(await res.json())
    expect(objects.size).toBe(0)
    await refused(await pull(a.token, body.workspaceId), 404, "no_checkpoint")
  })
})

describe("HT-HND-02: switches off, no GitHub, no agent, no plan minutes → refused", () => {
  it.each([
    ["harness.handoff off", { KRIYA_HARNESS_HANDOFF: "off" }],
    ["cloud.workspaces off", { KRIYA_CLOUD_WORKSPACES: "off" }],
    ["no cloud provider", { KRIYA_CLOUD_PROVIDER: "none" }],
    ["harness.api off", { KRIYA_HARNESS_API: "off" }],
  ])("%s → 404 saying nothing", async (_, env) => {
    const a = await person()
    harnessEnv({ ...ON, ...env })
    await refused(await upload(a.token), 404, "not_found")
    await nothingFor(a.user)
  })

  it("no GitHub connection → 403 not_connected", async () => {
    const a = await person({ github: false })
    await refused(await upload(a.token), 403, "not_connected")
    await nothingFor(a.user)
  })

  it("a device with no agent → 409 no_agent", async () => {
    const a = await person({ agent: false })
    await refused(await upload(a.token), 409, "no_agent")
    await nothingFor(a.user)
  })

  it("a plan without workspace minutes → 403 plan_not_allowed", async () => {
    const a = await person()
    await pg.query("update kriya.plans set workspace_minutes = 0")
    try {
      await refused(await upload(a.token), 403, "plan_not_allowed")
    } finally {
      await pg.query("update kriya.plans set workspace_minutes = 600")
    }
    await nothingFor(a.user)
  })

  it("a task that can't start → task_refused, and nothing half-made stays", async () => {
    const a = await person()
    harnessEnv({ ...ON, OPENROUTER_DEFAULT_MODEL: undefined })
    await refused(await upload(a.token), 503, "task_refused")
    await nothingFor(a.user)
  })

  it("no device token → 401; a malformed meta or no patch → 400", async () => {
    const a = await person()
    await refused(await upload("x".repeat(43)), 401, "unauthorized")
    await refused(await upload(a.token, "{not json"), 400, "bad_request")
    await refused(await upload(a.token, { ...META, baseSha: "main" }), 400, "bad_request")
    await refused(await upload(a.token, { ...META, extra: 1 }), 400, "bad_request")
    await refused(await upload(a.token, META, null), 400, "bad_request")
    await nothingFor(a.user)
  })
})

describe("HT-HND-03: hash or size mismatch refused; pull returns the latest checkpoint", () => {
  it("a wrong sha256 or byte count → 400 patch_mismatch, before storage", async () => {
    const a = await person()
    await refused(
      await upload(a.token, { ...META, sha256: "0".repeat(64) }),
      400,
      "patch_mismatch"
    )
    await refused(
      await upload(a.token, { ...META, bytes: PATCH.length + 1 }),
      400,
      "patch_mismatch"
    )
    await nothingFor(a.user)
  })

  it("a patch over cloud.maxCheckpointMb → 413 too_large, declared or not", async () => {
    const a = await person()
    const big = Buffer.alloc(1024 * 1024 + 1, "a")
    const meta = { ...META, sha256: digest(big), bytes: big.length }
    await refused(await upload(a.token, meta, big), 413, "too_large")
    await refused(
      await upload(a.token, META, PATCH, { "content-length": String(3 * 1024 * 1024) }),
      413,
      "too_large"
    )
    await nothingFor(a.user)
  })

  it("pull returns the exact bytes with X-Kriya-Sha256 and X-Kriya-Base-Sha", async () => {
    const a = await person()
    const body = HandoffResponse.parse(await (await upload(a.token)).json())
    const res = await pull(a.token, body.workspaceId)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/octet-stream")
    expect(res.headers.get("x-kriya-sha256")).toBe(META.sha256)
    expect(res.headers.get("x-kriya-base-sha")).toBe(BASE_SHA)
    expect(Buffer.from(await res.arrayBuffer()).equals(PATCH)).toBe(true)
  })

  it("pull follows the workspace's latest checkpoint, not the first", async () => {
    const a = await person()
    const body = HandoffResponse.parse(await (await upload(a.token)).json())
    const path = `workspaces/${a.user}/${body.workspaceId}/1-2.patch`
    const next = Buffer.from(PATCH.toString().replace("a * b", "b * a"))
    objects.set(path, next)
    await pg.query(
      "update kriya.workspaces set checkpoint_path = $1, checkpoint_sha256 = $2, checkpoint_seq = 2 where id = $3",
      [path, digest(next), body.workspaceId]
    )
    const res = await pull(a.token, body.workspaceId)
    expect(res.headers.get("x-kriya-sha256")).toBe(digest(next))
    expect(Buffer.from(await res.arrayBuffer()).equals(next)).toBe(true)
  })

  it("a stored checkpoint that no longer matches its digest is never served", async () => {
    const a = await person()
    const body = HandoffResponse.parse(await (await upload(a.token)).json())
    objects.set(`workspaces/${a.user}/${body.workspaceId}/0-1.patch`, Buffer.from("x"))
    await refused(await pull(a.token, body.workspaceId), 500, "server_error")
  })

  it("someone else's workspace, an unknown id or handoff off → 404", async () => {
    const a = await person()
    const b = await person()
    const body = HandoffResponse.parse(await (await upload(a.token)).json())
    await refused(await pull(b.token, body.workspaceId), 404, "not_found")
    await refused(await pull(a.token, "not-a-uuid"), 404, "not_found")
    await refused(
      await pull(a.token, "00000000-0000-4000-8000-000000000000"),
      404,
      "not_found"
    )
    harnessEnv({ ...ON, KRIYA_HARNESS_HANDOFF: "off" })
    await refused(await pull(a.token, body.workspaceId), 404, "not_found")
  })

  it("the meta schema is the one exported to contract.json", () => {
    expect(HandoffMeta.safeParse(META).success).toBe(true)
    expect(HandoffMeta.safeParse({ ...META, note: "x".repeat(2001) }).success).toBe(false)
  })
})
