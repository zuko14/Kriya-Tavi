import fs from "node:fs"
import type { AddressInfo } from "node:net"
import { builtinModules } from "node:module"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  dockerCreateArgs,
  hostFirewallInstalled,
  RUNNER_CAPS,
  type DockerPolicy,
} from "@/cloud-node/docker"
import { FenceStore } from "@/cloud-node/fences"
import { HEADERS, nodeKey, proxyToken, refOf, signedHeaders } from "@/cloud-node/protocol"
import { createNodeServer } from "@/cloud-node/server"
import { parseMeminfo, parsePsi } from "@/cloud-node/stats"

import { InProcessRuntime } from "./node-runtime"

// The node agent (CD-28, CD-31, CD-33, CD-34, CD-36; TEST_STRATEGY
// CT-SH-NODE-*, CT-SH-SEC-*, CT-SH-IMP-*): signed control calls, fences,
// the runner proxy, idle stop and disk quota, the hardened docker flags and
// the module boundary. The runtime is the real runner in-process.

const KEY = nodeKey("n".repeat(43), "n1")
const WS = "11111111-2222-4333-8444-555555555555"
const TOKEN = "t".repeat(43)

let runtime: InProcessRuntime
let node: ReturnType<typeof createNodeServer>
let base: string
let clock = Date.now()
const logs: string[] = []

function openBody(fence: number, extra: Record<string, unknown> = {}) {
  return {
    ref: refOf("n1", WS, 1),
    workspaceId: WS,
    generation: 1,
    fence,
    cpuMillis: 1000,
    memMb: 1024,
    diskMb: 1024,
    pids: 512,
    network: "offline",
    idleSeconds: 60,
    fresh: true,
    env: {
      KRIYA_RUNNER_TOKEN: TOKEN,
      KRIYA_RUNNER_LIMITS: JSON.stringify({ network: "offline" }),
      KRIYA_RUNNER_GENERATION: "1",
    },
    ...extra,
  }
}

async function signed(
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  opts: { key?: string; headers?: Record<string, string>; now?: number } = {}
) {
  const text = body === undefined ? "" : JSON.stringify(body)
  const res = await fetch(base + pathname, {
    method,
    headers: {
      "content-type": "application/json",
      ...signedHeaders(opts.key ?? KEY, method, pathname, text, opts.now ?? clock),
      ...opts.headers,
    },
    ...(method === "POST" && { body: text }),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  }
}

function runner(ref: string, fence: number, route = "/v1/exec", init: RequestInit = {}) {
  return fetch(`${base}/v1/runner/${ref}${route}`, {
    method: route === "/v1/health" ? "GET" : "POST",
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      [HEADERS.proxy]: proxyToken(KEY, ref, fence),
      [HEADERS.fence]: String(fence),
      ...(init.headers as Record<string, string>),
    },
  })
}

const exec = (ref: string, fence: number, command: string, signal?: AbortSignal) =>
  runner(ref, fence, "/v1/exec", {
    body: JSON.stringify({ command, timeoutSeconds: 30 }),
    signal,
  })

beforeEach(async () => {
  clock = Date.now()
  logs.length = 0
  runtime = new InProcessRuntime()
  node = createNodeServer({
    nodeId: "n1",
    key: KEY,
    runtime,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-node-state-")),
    dataDir: os.tmpdir(),
    reserve: { cpuMillis: 0, memMb: 0, diskMb: 0 },
    defaults: { idleSeconds: 900, diskMb: 1024 },
    now: () => clock,
    log: (message, fields) => logs.push(JSON.stringify({ message, ...fields })),
  })
  await node.reprobe()
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`
})

afterEach(async () => {
  node.server.closeAllConnections()
  await new Promise<void>((r) => node.server.close(() => r()))
  await runtime.closeAll()
})

describe("CT-SH-NODE-01: signed control calls", () => {
  it("accepts a signed call once and refuses tampering, other keys, old clocks and replays", async () => {
    expect((await signed("GET", "/v1/node")).status).toBe(200)
    expect(
      (await signed("GET", "/v1/node", undefined, { key: nodeKey("n".repeat(43), "n2") }))
        .status
    ).toBe(401)
    expect(
      (await signed("GET", "/v1/node", undefined, { now: clock - 61_000 })).status
    ).toBe(401)
    // The body is part of the signature
    const text = JSON.stringify(openBody(1))
    const headers = signedHeaders(KEY, "POST", "/v1/sandboxes/open", text, clock)
    const tampered = await fetch(`${base}/v1/sandboxes/open`, {
      method: "POST",
      headers,
      body: text.replace('"memMb":1024', '"memMb":9999'),
    })
    expect(tampered.status).toBe(401)
    const first = await fetch(`${base}/v1/sandboxes/open`, {
      method: "POST",
      headers,
      body: text,
    })
    expect(first.status).toBe(200)
    const replay = await fetch(`${base}/v1/sandboxes/open`, {
      method: "POST",
      headers,
      body: text,
    })
    expect(replay.status).toBe(401)
    // Unsigned
    expect((await fetch(`${base}/v1/sandboxes`)).status).toBe(401)
    // Health tells nothing but the protocol
    expect(await (await fetch(`${base}/v1/health`)).json()).toEqual({
      ok: true,
      protocol: "kriya-node/1",
    })
  })

  it("refuses an open whose ref, workspace and generation disagree, or for another node", async () => {
    expect(
      (await signed("POST", "/v1/sandboxes/open", openBody(1, { generation: 2 }))).status
    ).toBe(400)
    expect(
      (
        await signed(
          "POST",
          "/v1/sandboxes/open",
          openBody(1, { ref: refOf("n2", WS, 1) })
        )
      ).status
    ).toBe(400)
    runtime.probeResult = {
      ready: false,
      reasons: ["gVisor missing"],
      isolation: null,
      imageDigest: null,
    }
    await node.reprobe()
    const refused = await signed("POST", "/v1/sandboxes/open", openBody(1))
    expect(refused.status).toBe(503)
    expect(runtime.calls).toEqual([])
  })
})

describe("CT-SH-NODE-02: fences", () => {
  it("an older holder is locked out of the proxy and of stop the moment a newer one opens", async () => {
    const ref = refOf("n1", WS, 1)
    expect((await signed("POST", "/v1/sandboxes/open", openBody(5))).status).toBe(200)
    const ok = await exec(ref, 5, "echo one > a.txt; cat a.txt")
    expect(await ok.text()).toContain('"exitCode":0')
    // A newer holder resumes the same sandbox
    expect(
      (await signed("POST", "/v1/sandboxes/open", openBody(6, { fresh: false }))).status
    ).toBe(200)
    expect(runtime.calls).toContain(`restart ${ref}`)
    expect((await exec(ref, 5, "echo stale")).status).toBe(409)
    expect((await signed("POST", "/v1/sandboxes/stop", { ref, fence: 5 })).status).toBe(
      409
    )
    expect(
      (await signed("POST", "/v1/sandboxes/open", openBody(4, { fresh: false }))).status
    ).toBe(409)
    // The newer holder works and sees the older one's files
    const now = await exec(ref, 6, "cat a.txt")
    expect(await now.text()).toContain("one")
    // A forged token for the current fence is refused
    const forged = await fetch(`${base}/v1/runner/${ref}/v1/health`, {
      headers: {
        [HEADERS.proxy]: proxyToken(nodeKey("x".repeat(43), "n1"), ref, 6),
        [HEADERS.fence]: "6",
      },
    })
    expect(forged.status).toBe(401)
  })

  it("an older holder's slow open never restarts the sandbox after a newer one took it", async () => {
    const ref = refOf("n1", WS, 1)
    expect((await signed("POST", "/v1/sandboxes/open", openBody(5))).status).toBe(200)
    // The fence each restart ran under
    const restarts: number[] = []
    const restart = runtime.restart.bind(runtime)
    runtime.restart = async (r) => {
      restarts.push(node.fences.get(r))
      await restart(r)
    }
    // The first inspect (fence 6's open) is slow, so fence 7 arrives meanwhile
    const inspect = runtime.inspect.bind(runtime)
    let slow = true
    runtime.inspect = async (r) => {
      if (slow) {
        slow = false
        await new Promise((done) => setTimeout(done, 150))
      }
      return inspect(r)
    }
    const older = signed("POST", "/v1/sandboxes/open", openBody(6, { fresh: false }))
    await new Promise((done) => setTimeout(done, 30))
    const newer = signed("POST", "/v1/sandboxes/open", openBody(7, { fresh: false }))
    expect((await newer).status).toBe(200)
    expect((await older).status).toBe(200)
    // One after the other, each under its own fence; none under 7 by 6
    expect(restarts).toEqual([6, 7])
    expect((await exec(ref, 7, "echo ok")).status).toBe(200)
  })

  it("fences survive an agent restart and only go up", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-fences-"))
    const a = new FenceStore(dir)
    expect(a.advance("r", 7)).toBe(true)
    expect(a.advance("r", 3)).toBe(false)
    const b = new FenceStore(dir)
    expect(b.get("r")).toBe(7)
    expect(b.advance("r", 6)).toBe(false)
    b.delete("r")
    expect(new FenceStore(dir).get("r")).toBe(0)
  })

  it("a retried open with the same fence is idempotent; a fresh open never adopts an existing disk", async () => {
    expect((await signed("POST", "/v1/sandboxes/open", openBody(3))).status).toBe(200)
    expect((await signed("POST", "/v1/sandboxes/open", openBody(3))).status).toBe(200)
    expect(runtime.calls.filter((c) => c.startsWith("create"))).toHaveLength(1)
    expect((await signed("POST", "/v1/sandboxes/open", openBody(4))).status).toBe(409)
  })
})

describe("CT-SH-NODE-03: proxy and cancellation", () => {
  it("a caller that goes away stops the command (the cancellation path)", async () => {
    const ref = refOf("n1", WS, 1)
    await signed("POST", "/v1/sandboxes/open", openBody(1))
    const abort = new AbortController()
    const started = Date.now()
    const pending = exec(ref, 1, "sleep 3; echo late > late.txt", abort.signal)
      .then((r) => r.text())
      .catch(() => "aborted")
    await new Promise((r) => setTimeout(r, 400))
    abort.abort()
    expect(await pending).toBe("aborted")
    await new Promise((r) => setTimeout(r, 3500))
    const root = path.join(runtime.base, ref, "workspace")
    expect(fs.existsSync(path.join(root, "late.txt"))).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  it("refuses unknown routes, bad refs and stopped sandboxes", async () => {
    const ref = refOf("n1", WS, 1)
    expect((await runner(ref, 1, "/v1/health")).status).toBe(409)
    await signed("POST", "/v1/sandboxes/open", openBody(1))
    expect((await runner(ref, 1, "/v1/health")).status).toBe(200)
    // fetch normalises "..", landing on an unsigned control path
    expect((await fetch(`${base}/v1/runner/../../etc/passwd`)).status).toBe(401)
    expect((await runner(ref, 1, "/..%2F..%2Fetc%2Fpasswd")).status).toBe(404)
    expect((await runner(ref, 1, "/v1/../../x")).status).not.toBe(200)
    await signed("POST", "/v1/sandboxes/stop", { ref, fence: 1 })
    expect((await runner(ref, 1, "/v1/health")).status).toBe(404)
  })
})

describe("CT-SH-NODE-04: the node's own clock", () => {
  it("stops a sandbox idle past its time, not one with a request in flight; touch resets it", async () => {
    const ref = refOf("n1", WS, 1)
    await signed("POST", "/v1/sandboxes/open", openBody(1))
    clock += 30_000
    await node.sweep()
    expect((await runtime.inspect(ref))?.running).toBe(true)
    expect((await signed("POST", "/v1/sandboxes/touch", { ref, fence: 1 })).status).toBe(
      200
    )
    clock += 45_000
    await node.sweep()
    expect((await runtime.inspect(ref))?.running).toBe(true)
    // A long command keeps it alive past the idle time
    const long = exec(ref, 1, "sleep 1; echo done").then((r) => r.text())
    await new Promise((r) => setTimeout(r, 200))
    clock += 120_000
    await node.sweep()
    expect((await runtime.inspect(ref))?.running).toBe(true)
    expect(await long).toContain("done")
    clock += 61_000
    await node.sweep()
    expect((await runtime.inspect(ref))?.running).toBe(false)
    expect(logs.join("\n")).toContain('"reason":"idle"')
  })

  it("stops a sandbox over its disk quota", async () => {
    const ref = refOf("n1", WS, 1)
    await signed("POST", "/v1/sandboxes/open", openBody(1))
    runtime.sizes.set(ref, 1025 * 1024 * 1024)
    await node.sweep({ usage: true })
    expect((await runtime.inspect(ref))?.running).toBe(false)
    expect(logs.join("\n")).toContain('"reason":"disk_quota"')
  })

  it("never writes the runner token into its log, list or stats", async () => {
    const ref = refOf("n1", WS, 1)
    await signed("POST", "/v1/sandboxes/open", openBody(1))
    await exec(ref, 1, "echo hi")
    const seen = JSON.stringify([
      logs,
      (await signed("GET", "/v1/sandboxes")).body,
      (await signed("GET", "/v1/node")).body,
    ])
    expect(seen).not.toContain(TOKEN)
    expect(seen).not.toContain(KEY)
  })
})

describe("CT-SH-NODE-05: measurements", () => {
  it("reads PSI and meminfo", () => {
    expect(
      parsePsi(
        "some avg10=12.34 avg60=1.00 avg300=0.10 total=99\nfull avg10=5.00 avg60=0 avg300=0 total=1"
      )
    ).toBe(12.34)
    expect(parsePsi("garbage")).toBeNull()
    expect(
      parseMeminfo(
        "MemTotal:       8000000 kB\nMemFree: 1 kB\nMemAvailable:   4096000 kB\n"
      )
    ).toEqual({
      totalMb: 7812,
      availableMb: 4000,
    })
  })
})

const POLICY: DockerPolicy = {
  image: `kriya-runner@sha256:${"a".repeat(64)}`,
  runtime: "runsc",
  network: "kriya-sbx",
  publish: false,
  requireHostFirewall: true,
  tmpMb: 1024,
}
const SPEC = {
  ref: refOf("n1", WS, 1),
  workspaceId: WS,
  cpuMillis: 2000,
  memMb: 4096,
  diskMb: 10_240,
  pids: 2048,
  env: {
    KRIYA_RUNNER_TOKEN: TOKEN,
    KRIYA_RUNNER_LIMITS: "{}",
    KRIYA_RUNNER_GENERATION: "1",
  },
}

describe("CT-SH-SEC-01…05: the sandbox's docker flags", () => {
  const args = dockerCreateArgs(SPEC, POLICY)
  const pair = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))

  it("gVisor, its own network, a read-only root and only the runner's capabilities", () => {
    expect(pair("--runtime")).toEqual(["runsc"])
    expect(pair("--network")).toEqual(["kriya-sbx"])
    expect(args).toContain("--read-only")
    expect(pair("--cap-drop")).toEqual(["ALL"])
    expect(pair("--cap-add")).toEqual(RUNNER_CAPS)
    expect(RUNNER_CAPS).not.toContain("SYS_ADMIN")
    expect(RUNNER_CAPS).not.toContain("NET_RAW")
    expect(pair("--security-opt")).toEqual(["no-new-privileges"])
  })

  it("CPU, memory without swap, processes, files and time", () => {
    expect(pair("--memory")).toEqual(["4096m"])
    expect(pair("--memory-swap")).toEqual(["4096m"])
    expect(pair("--cpus")).toEqual(["2.00"])
    expect(pair("--pids-limit")).toEqual(["2048"])
    expect(pair("--ulimit")).toEqual(["nofile=4096:8192"])
    expect(pair("--restart")).toEqual(["no"])
  })

  it("nothing of the host: no privilege, socket, host namespace, bind mount or published port", () => {
    const text = args.join(" ")
    for (const banned of [
      "--privileged",
      "docker.sock",
      "--pid",
      "--ipc",
      "--userns",
      "--device",
      "--volume",
      "-v",
      "--publish",
      "host",
      "seccomp=unconfined",
      "apparmor=unconfined",
    ])
      expect(
        args.includes(banned) ||
          text.includes(`${banned}=`) ||
          text.includes(` ${banned} `),
        banned
      ).toBe(false)
    expect(pair("--mount").every((m) => m.startsWith("type=volume,src=sh-n1-"))).toBe(
      true
    )
  })

  it("the runner's token only by name: its value never appears in an argument", () => {
    expect(args.join(" ")).not.toContain(TOKEN)
    expect(pair("--env")).toEqual([
      "KRIYA_RUNNER_GENERATION",
      "KRIYA_RUNNER_LIMITS",
      "KRIYA_RUNNER_TOKEN",
    ])
  })

  it("the host firewall counts as installed only with the jump and every drop", () => {
    const chain = [
      "-N KRIYA-SBX",
      "-A KRIYA-SBX -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
      ...[
        "10.0.0.0/8",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
      ].map((n) => `-A KRIYA-SBX -d ${n} -j DROP`),
      "-A KRIYA-SBX -j RETURN",
    ].join("\n")
    const jump =
      "-N DOCKER-USER\n-A DOCKER-USER -i kriya-sbx0 -j KRIYA-SBX\n-A DOCKER-USER -j RETURN"
    expect(hostFirewallInstalled(jump, chain)).toBe(true)
    expect(hostFirewallInstalled("-N DOCKER-USER\n-A DOCKER-USER -j RETURN", chain)).toBe(
      false
    )
    expect(
      hostFirewallInstalled(jump, chain.replace("-d 169.254.0.0/16 -j DROP", ""))
    ).toBe(false)
  })

  it("the image is the pinned one, and the dev-only port publish is opt-in", () => {
    expect(args).toContain(POLICY.image)
    expect(dockerCreateArgs(SPEC, { ...POLICY, publish: true })).toContain("--publish")
  })
})

describe("CT-SH-IMP-01: kriya-node imports nothing of Kriya", () => {
  it("only Node built-ins, zod and its own files; only lib/cloud and tests import it", () => {
    const dir = path.join(process.cwd(), "cloud-node")
    const builtins = new Set(builtinModules)
    const bad: string[] = []
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8")
      for (const m of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1]
        if (spec.startsWith("node:") || builtins.has(spec) || spec === "zod") continue
        if (spec.startsWith("./") && !spec.includes("..")) continue
        bad.push(`${file}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
    const users: string[] = []
    const walk = (d: string) => {
      for (const item of fs.readdirSync(d, { withFileTypes: true })) {
        if (
          ["node_modules", ".next", ".git", ".claude", "tests", "cloud-node"].includes(
            item.name
          )
        )
          continue
        const full = path.join(d, item.name)
        if (item.isDirectory()) walk(full)
        else if (
          /\.tsx?$/.test(item.name) &&
          fs.readFileSync(full, "utf8").includes("@/cloud-node")
        )
          users.push(path.relative(process.cwd(), full))
      }
    }
    walk(process.cwd())
    // The owner's key tool (runbook §2 step 7) derives a node key, nothing else
    expect(
      users.filter(
        (f) => !f.startsWith("lib/cloud/") && f !== "scripts/cloud-node-key.ts"
      )
    ).toEqual([])
  })
})
