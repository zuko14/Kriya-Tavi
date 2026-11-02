import { afterEach, describe, expect, it, vi } from "vitest"

import {
  REGISTRY_HOSTS,
  WorkspaceProviderError,
  type WorkspaceProvider,
  type WorkspaceSpec,
} from "@/lib/cloud/provider"
import { DaytonaWorkspaceProvider } from "@/lib/cloud/providers/daytona"
import { E2BWorkspaceProvider } from "@/lib/cloud/providers/e2b"
import { log } from "@/lib/log"

// The vendor adapters (TOOLS_AND_CONTRACTS §1, TEST_STRATEGY CT-PRV-02…06).
// NOT RECORDED: the answers below are built from each vendor's published
// API description, read 2026-10-31 (E2B: e2b-dev/infra spec/openapi.yml and
// packages/envd/spec; Daytona: daytona.io/docs/openapi.json and
// toolbox-openapi.json). They are replaced with recorded answers on the
// first owner-approved run (CB-02); until then they prove the adapters'
// own rules, not the vendors' behaviour.

const TOKEN = "t".repeat(43)
const KEY = "provider-key-not-real"

const spec = (over: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
  workspaceId: "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  userId: "11111111-2222-4333-8444-555555555555",
  generation: 3,
  image: "kriya-runner-v1",
  size: "2c-4g",
  network: "registries",
  runnerToken: TOKEN,
  limits: { commandTimeoutSeconds: 600 },
  timeoutSeconds: 600,
  ...over,
})

type Call = { method: string; url: string; headers: Record<string, string>; body: string }
type Reply = Response | Error | ((call: Call) => Response | Error)

// A fetch that answers by "METHOD url-prefix" and records every request
function fakeFetch(routes: [string, Reply | Reply[]][]) {
  const calls: Call[] = []
  const queues = new Map(routes.map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? "GET"
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const body =
      init.body instanceof Uint8Array
        ? Buffer.from(init.body).toString("utf8")
        : typeof init.body === "string"
          ? init.body
          : ""
    const call = { method, url, headers, body }
    calls.push(call)
    const key = [...queues.keys()]
      .filter((k) => {
        const [m, prefix] = k.split(" ")
        return m === method && url.startsWith(prefix)
      })
      .sort((a, b) => b.length - a.length)[0]
    if (!key) throw new Error(`no route for ${method} ${url}`)
    const entry = queues.get(key)!
    const next = Array.isArray(entry) ? entry.shift() : entry
    if (!next) throw new Error(`route ${key} exhausted`)
    const reply = typeof next === "function" ? next(call) : next
    if (reply instanceof Error) throw reply
    return reply.clone()
  }) as typeof fetch
  return { fetcher, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
const transport = () => new TypeError("fetch failed")

// A Connect server stream: one enveloped JSON message each, left open
function connectStream(messages: unknown[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const message of messages) {
          const bytes = Buffer.from(JSON.stringify(message))
          const frame = Buffer.alloc(5 + bytes.length)
          frame.writeUInt8(0, 0)
          frame.writeUInt32BE(bytes.length, 1)
          bytes.copy(frame, 5)
          controller.enqueue(new Uint8Array(frame))
        }
        // Not closed: a running process keeps its stream open
      },
    }),
    { status: 200, headers: { "content-type": "application/connect+json" } }
  )
}
// The JSON inside a Connect request's first envelope
const unframe = (body: string) =>
  JSON.parse(Buffer.from(body, "utf8").subarray(5).toString())

const E2B = "https://api.e2b.app"
const e2bSandbox = {
  templateID: "kriya-runner-v1",
  sandboxID: "isb7dkx1",
  clientID: "c",
  envdVersion: "0.2.4",
  envdAccessToken: "envd-access",
  trafficAccessToken: "traffic-access",
  domain: "e2b.app",
}
const ENVD = "https://49983-isb7dkx1.e2b.app/process.Process/Start"

const DT = "https://app.daytona.io/api"
const TOOLBOX = "https://proxy.app.daytona.io/toolbox"
const dtSandbox = (state: string) => ({
  id: "dsb-42",
  name: "dsb-42",
  state,
  labels: { kriya_env: "kriya.example", workspace_id: spec().workspaceId },
  env: {},
  toolboxProxyUrl: TOOLBOX,
  public: false,
  networkBlockAll: false,
})
const SIGNED = "https://10000-signedtok.proxy.daytona.works"

const e2b = (routes: [string, Reply | Reply[]][]) => {
  const f = fakeFetch(routes)
  return {
    ...f,
    provider: new E2BWorkspaceProvider({
      apiKey: KEY,
      env: "kriya.example",
      fetch: f.fetcher,
    }),
  }
}
const daytona = (routes: [string, Reply | Reply[]][]) => {
  const f = fakeFetch(routes)
  return {
    ...f,
    provider: new DaytonaWorkspaceProvider({
      apiKey: KEY,
      env: "kriya.example",
      fetch: f.fetcher,
      pollMs: 0,
    }),
  }
}

afterEach(() => vi.restoreAllMocks())

describe("CT-PRV-02: create passes the token only to the runner process, tags without personal data, asks for the network policy", () => {
  it("e2b", async () => {
    const { provider, calls } = e2b([
      [`POST ${E2B}/v2/sandboxes`, json(e2bSandbox, 201)],
      [`POST ${ENVD}`, connectStream([{ event: { start: { pid: 7 } } }])],
    ])
    const opened = await provider.create(spec())
    expect(opened).toEqual({
      ref: "isb7dkx1",
      runnerUrl: "https://10000-isb7dkx1.e2b.app",
      headers: { "e2b-traffic-access-token": "traffic-access" },
    })
    const [create, start] = calls
    expect(create.headers["x-api-key"]).toBe(KEY)
    const body = JSON.parse(create.body)
    expect(body).toMatchObject({
      templateID: "kriya-runner-v1",
      timeout: 600,
      autoPause: true,
      metadata: { kriya_env: "kriya.example", workspace_id: spec().workspaceId },
      network: {
        allowPublicTraffic: false,
        allowOut: REGISTRY_HOSTS,
        denyOut: ["0.0.0.0/0"],
      },
    })
    expect(Object.keys(body.metadata).sort()).toEqual(["kriya_env", "workspace_id"])
    expect(body.envVars).toBeUndefined()
    // The token: only in the runner process's environment, nowhere else
    for (const call of calls.filter((c) => c !== start)) {
      expect(call.url + call.body + JSON.stringify(call.headers)).not.toContain(TOKEN)
    }
    expect(start.url).not.toContain(TOKEN)
    expect(start.headers["x-access-token"]).toBe("envd-access")
    expect(start.headers.authorization).toBe(
      `Basic ${Buffer.from("root:").toString("base64")}`
    )
    expect(start.headers["content-type"]).toBe("application/connect+json")
    const process = unframe(start.body).process
    expect(process).toMatchObject({ cwd: "/app", cmd: "/usr/local/bin/node" })
    expect(process.envs).toEqual({
      KRIYA_RUNNER_TOKEN: TOKEN,
      KRIYA_RUNNER_LIMITS: JSON.stringify({ commandTimeoutSeconds: 600 }),
      KRIYA_RUNNER_GENERATION: "3",
    })
    for (const call of calls) expect(call.url + call.body).not.toContain(spec().userId)
  })

  it("e2b offline: no internet at all", async () => {
    const { provider, calls } = e2b([
      [`POST ${E2B}/v2/sandboxes`, json(e2bSandbox, 201)],
      [`POST ${ENVD}`, connectStream([{ event: { start: { pid: 7 } } }])],
    ])
    await provider.create(spec({ network: "offline" }))
    const body = JSON.parse(calls[0].body)
    expect(body.allow_internet_access).toBe(false)
    expect(body.network.allowOut).toBeUndefined()
    expect(body.network.denyOut).toEqual(["0.0.0.0/0"])
  })

  it("e2b: a runner that doesn't start leaves no sandbox behind", async () => {
    const { provider, calls } = e2b([
      [`POST ${E2B}/v2/sandboxes`, json(e2bSandbox, 201)],
      [`POST ${ENVD}`, json({ code: "unauthenticated", message: "x" }, 401)],
      [`DELETE ${E2B}/sandboxes/isb7dkx1`, new Response(null, { status: 204 })],
    ])
    await expect(provider.create(spec())).rejects.toBeInstanceOf(WorkspaceProviderError)
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" })
  })

  it("daytona", async () => {
    const { provider, calls } = daytona([
      [`POST ${DT}/sandbox`, json(dtSandbox("creating"))],
      [
        `GET ${DT}/sandbox/dsb-42`,
        [json(dtSandbox("creating")), json(dtSandbox("started"))],
      ],
      [`POST ${TOOLBOX}/dsb-42/process/execute`, json({ exitCode: 0, result: "" })],
      [
        `GET ${DT}/sandbox/dsb-42/ports/10000/signed-preview-url`,
        json({ sandboxId: "dsb-42", port: 10000, token: "signedtok", url: SIGNED }),
      ],
    ])
    const opened = await provider.create(spec())
    expect(opened).toEqual({ ref: "dsb-42", runnerUrl: SIGNED })
    const create = calls[0]
    expect(create.headers.authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(create.body)
    expect(body).toMatchObject({
      snapshot: "kriya-runner-v1",
      labels: { kriya_env: "kriya.example", workspace_id: spec().workspaceId },
      public: false,
      domainAllowList: REGISTRY_HOSTS.join(","),
      autoStopInterval: 10,
    })
    expect(body.env).toBeUndefined()
    expect(Object.keys(body.labels).sort()).toEqual(["kriya_env", "workspace_id"])
    const execute = calls.find((c) => c.url.endsWith("/process/execute"))!
    const run = JSON.parse(execute.body)
    // In envs, never in the command text (Daytona keeps command history)
    expect(run.command).not.toContain(TOKEN)
    expect(run.envs.KRIYA_RUNNER_TOKEN).toBe(TOKEN)
    const signed = calls.find((c) => c.url.includes("signed-preview-url"))!
    expect(new URL(signed.url).searchParams.get("expiresInSeconds")).toBe("10800")
    for (const call of calls.filter((c) => c !== execute)) {
      expect(call.url + call.body).not.toContain(TOKEN)
    }
    for (const call of calls) expect(call.url + call.body).not.toContain(spec().userId)
  })

  it("daytona offline blocks all network; a failed start is cleaned up", async () => {
    const { provider, calls } = daytona([
      [`POST ${DT}/sandbox`, json(dtSandbox("creating"))],
      [
        `GET ${DT}/sandbox/dsb-42`,
        json({ ...dtSandbox("error"), errorReason: "image pull failed" }),
      ],
      [`DELETE ${DT}/sandbox/dsb-42`, json({})],
    ])
    await expect(provider.create(spec({ network: "offline" }))).rejects.toThrow(
      "The cloud workspace couldn't be started at the provider."
    )
    const body = JSON.parse(calls[0].body)
    expect(body.networkBlockAll).toBe(true)
    expect(body.domainAllowList).toBeUndefined()
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" })
  })
})

describe("CT-PRV-03: resume maps not found to null", () => {
  it("e2b: 404 → null; found → the runner, resumed", async () => {
    const gone = e2b([
      [
        `POST ${E2B}/v2/sandboxes/isb7dkx1/connect`,
        json({ code: 404, message: "not found" }, 404),
      ],
    ])
    expect(await gone.provider.resume("isb7dkx1", spec())).toBeNull()
    const back = e2b([
      [`POST ${E2B}/v2/sandboxes/isb7dkx1/connect`, json(e2bSandbox, 201)],
    ])
    expect(await back.provider.resume("isb7dkx1", spec())).toMatchObject({
      ref: "isb7dkx1",
      runnerUrl: "https://10000-isb7dkx1.e2b.app",
    })
    expect(JSON.parse(back.calls[0].body)).toEqual({ timeout: 600 })
  })

  it("daytona: 404 or destroyed → null; stopped → started and the runner relaunched", async () => {
    const gone = daytona([
      [`GET ${DT}/sandbox/dsb-42`, json({ message: "not found" }, 404)],
    ])
    expect(await gone.provider.resume("dsb-42", spec())).toBeNull()
    const destroyed = daytona([
      [`GET ${DT}/sandbox/dsb-42`, json(dtSandbox("destroyed"))],
    ])
    expect(await destroyed.provider.resume("dsb-42", spec())).toBeNull()
    const stopped = daytona([
      [
        `GET ${DT}/sandbox/dsb-42`,
        [json(dtSandbox("stopped")), json(dtSandbox("started"))],
      ],
      [`POST ${DT}/sandbox/dsb-42/start`, json(dtSandbox("starting"))],
      [`POST ${TOOLBOX}/dsb-42/process/execute`, json({ exitCode: 0, result: "" })],
      [
        `GET ${DT}/sandbox/dsb-42/ports/10000/signed-preview-url`,
        json({ sandboxId: "dsb-42", port: 10000, token: "signedtok", url: SIGNED }),
      ],
    ])
    expect(await stopped.provider.resume("dsb-42", spec())).toEqual({
      ref: "dsb-42",
      runnerUrl: SIGNED,
    })
    expect(
      stopped.calls.map(
        (c) => `${c.method} ${new URL(c.url).pathname.split("/").slice(-1)[0]}`
      )
    ).toEqual([
      "GET dsb-42",
      "POST start",
      "GET dsb-42",
      "POST execute",
      "GET signed-preview-url",
    ])
  })
})

describe("CT-PRV-04: destroy is idempotent; idempotent calls retry twice on transport errors; create never retries", () => {
  it("e2b", async () => {
    const gone = e2b([
      [`DELETE ${E2B}/sandboxes/isb7dkx1`, json({ code: 404, message: "x" }, 404)],
    ])
    await expect(gone.provider.destroy("isb7dkx1")).resolves.toBeUndefined()

    const flaky = e2b([
      [
        `POST ${E2B}/sandboxes/isb7dkx1/pause`,
        [transport(), transport(), new Response(null, { status: 204 })],
      ],
      [
        `POST ${E2B}/sandboxes/isb7dkx1/timeout`,
        [transport(), new Response(null, { status: 204 })],
      ],
    ])
    await flaky.provider.pause("isb7dkx1")
    await flaky.provider.extend("isb7dkx1", 600)
    expect(flaky.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/sandboxes/isb7dkx1/pause",
      "/sandboxes/isb7dkx1/pause",
      "/sandboxes/isb7dkx1/pause",
      "/sandboxes/isb7dkx1/timeout",
      "/sandboxes/isb7dkx1/timeout",
    ])
    expect(JSON.parse(flaky.calls.at(-1)!.body)).toEqual({ timeout: 600 })

    const down = e2b([
      [`DELETE ${E2B}/sandboxes/isb7dkx1`, [transport(), transport(), transport()]],
    ])
    await expect(down.provider.destroy("isb7dkx1")).rejects.toThrow("couldn't be reached")
    expect(down.calls).toHaveLength(3)

    const once = e2b([[`POST ${E2B}/v2/sandboxes`, [transport(), json(e2bSandbox, 201)]]])
    await expect(once.provider.create(spec())).rejects.toBeInstanceOf(
      WorkspaceProviderError
    )
    expect(once.calls).toHaveLength(1)
  })

  it("daytona", async () => {
    const gone = daytona([[`DELETE ${DT}/sandbox/dsb-42`, json({ message: "x" }, 404)]])
    await expect(gone.provider.destroy("dsb-42")).resolves.toBeUndefined()
    const flaky = daytona([
      [`POST ${DT}/sandbox/dsb-42/stop`, [transport(), transport(), json({})]],
      [`POST ${DT}/sandbox/dsb-42/last-activity`, [transport(), json({})]],
    ])
    await flaky.provider.pause("dsb-42")
    await (flaky.provider as WorkspaceProvider).extend("dsb-42", 600)
    expect(flaky.calls).toHaveLength(5)
    const once = daytona([
      [`POST ${DT}/sandbox`, [transport(), json(dtSandbox("started"))]],
    ])
    await expect(once.provider.create(spec())).rejects.toBeInstanceOf(
      WorkspaceProviderError
    )
    expect(once.calls).toHaveLength(1)
  })
})

describe("CT-PRV-05: provider errors become plain messages; logs carry status codes only", () => {
  it("never the payload, the key or the token", async () => {
    const warn = vi.spyOn(log, "warn")
    const payload = { code: 401, message: `invalid key ${KEY} for sandbox secret-detail` }
    const { provider } = e2b([[`POST ${E2B}/v2/sandboxes`, json(payload, 401)]])
    const error = (await provider.create(spec()).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(WorkspaceProviderError)
    expect(error.message).toBe("The cloud workspace provider refused Kriya's key.")
    const dt = daytona([
      [`POST ${DT}/sandbox/dsb-42/stop`, json({ message: "secret-detail" }, 500)],
    ])
    await expect(dt.provider.pause("dsb-42")).rejects.toThrow(
      "The cloud workspace provider had an error."
    )
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain("401")
    expect(logged).toContain("500")
    for (const secret of [KEY, TOKEN, "secret-detail", "api.e2b.app", "daytona.io"])
      expect(logged).not.toContain(secret)
  })
})

describe("CT-PRV-06: list maps tags back to workspace ids, this deployment only", () => {
  it("e2b: filters by kriya_env, follows the next token", async () => {
    const page = (id: string, state: string, workspaceId?: string) => ({
      templateID: "t",
      sandboxID: id,
      clientID: "c",
      startedAt: "2026-10-31T00:00:00Z",
      endAt: "2026-10-31T01:00:00Z",
      cpuCount: 2,
      memoryMB: 4096,
      diskSizeMB: 10240,
      state,
      envdVersion: "0.2.4",
      metadata: workspaceId
        ? { kriya_env: "kriya.example", workspace_id: workspaceId }
        : { kriya_env: "kriya.example" },
    })
    const { provider, calls } = e2b([
      [
        `GET ${E2B}/v2/sandboxes`,
        [
          json([page("a", "running", "w-1")], 200, { "x-next-token": "n2" }),
          json([page("b", "paused", "w-2"), page("c", "running")]),
        ],
      ],
    ])
    expect(await provider.list()).toEqual([
      { ref: "a", workspaceId: "w-1", running: true },
      { ref: "b", workspaceId: "w-2", running: false },
      { ref: "c", workspaceId: null, running: true },
    ])
    const first = new URL(calls[0].url)
    expect(first.searchParams.get("metadata")).toBe("kriya_env=kriya.example")
    expect(first.searchParams.get("state")).toBe("running,paused")
    expect(new URL(calls[1].url).searchParams.get("nextToken")).toBe("n2")
  })

  it("daytona: filters by labels, follows the cursor, skips destroyed", async () => {
    const { provider, calls } = daytona([
      [
        `GET ${DT}/sandbox?`,
        [
          json({ items: [dtSandbox("started")], nextCursor: "c2" }),
          json({
            items: [
              {
                ...dtSandbox("stopped"),
                id: "dsb-43",
                labels: { kriya_env: "kriya.example" },
              },
              { ...dtSandbox("destroyed"), id: "dsb-44" },
            ],
            nextCursor: null,
          }),
        ],
      ],
    ])
    expect(await provider.list()).toEqual([
      { ref: "dsb-42", workspaceId: spec().workspaceId, running: true },
      { ref: "dsb-43", workspaceId: null, running: false },
    ])
    expect(JSON.parse(new URL(calls[0].url).searchParams.get("labels")!)).toEqual({
      kriya_env: "kriya.example",
    })
    expect(new URL(calls[1].url).searchParams.get("cursor")).toBe("c2")
  })
})
