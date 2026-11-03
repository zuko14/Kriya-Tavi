import { execFile } from "node:child_process"
import fs from "node:fs"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { DockerRuntime } from "@/cloud-node/docker"
import { HEADERS, nodeKey, proxyToken, refOf, signedHeaders } from "@/cloud-node/protocol"
import { createNodeServer } from "@/cloud-node/server"

// The node agent on a real Docker engine with the real runner image
// (SH5; SELF_HOSTED_THREAT_MODEL §6, CT-SH-DOCKER-*). KRIYA_NODE_DOCKER=1
// only: it needs Docker and the image (KRIYA_ISO_IMAGE, default
// kriya-runner:c9). It proves what the container configuration enforces —
// identity, capabilities, read-only root, cgroup memory/pids/CPU limits,
// OOM containment, the fence restart, cleanup, and fail-closed probes —
// under runc on this machine. It does NOT prove the gVisor boundary: that
// needs runsc on the target host (OA-2, runbook §2 step 6).

const ON = process.env.KRIYA_NODE_DOCKER === "1"
const IMAGE_TAG = process.env.KRIYA_ISO_IMAGE ?? "kriya-runner:c9"
const NETWORK = "kriya-sbx-test"
const KEY = nodeKey("d".repeat(43), "dock")
const TOKEN = "k".repeat(43)
const run = promisify(execFile)
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim()
const report: Record<string, unknown> = { at: new Date().toISOString(), runtime: "runc" }

let node: ReturnType<typeof createNodeServer>
let base: string
let image: string
const refs: string[] = []

async function signed(method: "GET" | "POST", pathname: string, body?: unknown) {
  const text = body === undefined ? "" : JSON.stringify(body)
  const res = await fetch(base + pathname, {
    method,
    headers: {
      "content-type": "application/json",
      ...signedHeaders(KEY, method, pathname, text),
    },
    ...(method === "POST" && { body: text }),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  }
}

function open(ws: string, fence: number, extra: Record<string, unknown> = {}) {
  const ref = refOf("dock", ws, 1)
  if (!refs.includes(ref)) refs.push(ref)
  return signed("POST", "/v1/sandboxes/open", {
    ref,
    workspaceId: ws,
    generation: 1,
    fence,
    cpuMillis: 500,
    memMb: 512,
    diskMb: 1024,
    pids: 256,
    network: "offline",
    idleSeconds: 600,
    fresh: true,
    env: {
      KRIYA_RUNNER_TOKEN: TOKEN,
      KRIYA_RUNNER_LIMITS: JSON.stringify({
        network: "offline",
        commandTimeoutSeconds: 60,
      }),
      KRIYA_RUNNER_GENERATION: "1",
    },
    ...extra,
  })
}

async function healthy(ref: string, fence: number) {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/v1/runner/${ref}/v1/health`, {
      headers: {
        [HEADERS.proxy]: proxyToken(KEY, ref, fence),
        [HEADERS.fence]: String(fence),
      },
    }).catch(() => null)
    if (res?.ok) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("runner never healthy")
}

async function sh(ref: string, fence: number, command: string, timeoutSeconds = 30) {
  const res = await fetch(`${base}/v1/runner/${ref}/v1/exec`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      [HEADERS.proxy]: proxyToken(KEY, ref, fence),
      [HEADERS.fence]: String(fence),
    },
    body: JSON.stringify({ command, timeoutSeconds }),
  })
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  const end = lines.find((l) => l.type === "end")
  const out = lines
    .filter((l) => l.type === "out")
    .map((l) => l.data ?? l.text ?? "")
    .join("")
  return {
    exitCode: end?.exitCode as number | null,
    out: out + (end?.head ?? "") + (end?.tail ?? ""),
    end,
  }
}

const WS = [
  "aaaaaaaa-0000-4000-8000-000000000001",
  "aaaaaaaa-0000-4000-8000-000000000002",
]

describe.skipIf(!ON)("CT-SH-DOCKER: kriya-node on a real Docker engine", () => {
  beforeAll(async () => {
    image = await docker("image", "inspect", "--format", "{{.Id}}", IMAGE_TAG)
    report.image = { tag: IMAGE_TAG, id: image }
    report.engine = await docker(
      "info",
      "--format",
      "{{.ServerVersion}} {{.KernelVersion}} cgroup v{{.CgroupVersion}}"
    )
    await docker(
      "network",
      "create",
      "--driver",
      "bridge",
      "--opt",
      "com.docker.network.bridge.enable_icc=false",
      NETWORK
    ).catch(() => "")
    node = createNodeServer({
      nodeId: "dock",
      key: KEY,
      runtime: new DockerRuntime({
        image,
        runtime: "runc",
        network: NETWORK,
        publish: true,
        requireHostFirewall: false,
        tmpMb: 256,
      }),
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-node-docker-")),
      dataDir: os.tmpdir(),
      reserve: { cpuMillis: 0, memMb: 0, diskMb: 0 },
      defaults: { idleSeconds: 600, diskMb: 1024 },
    })
    report.probe = await node.reprobe()
    await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`
  }, 120_000)

  afterAll(async () => {
    for (const ref of refs)
      await signed("POST", "/v1/sandboxes/destroy", { ref }).catch(() => {})
    node?.server.closeAllConnections()
    await new Promise<void>((r) => node?.server.close(() => r()))
    await docker("network", "rm", NETWORK).catch(() => "")
    const out = path.join(process.cwd(), "screenshots", "cloud-execution", "SH5")
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, "node-docker.json"), JSON.stringify(report, null, 2))
  }, 120_000)

  it("DOCKER-01: the probe passes on runc with a pinned image and a no-ICC network", () => {
    expect(node.probe).toMatchObject({
      ready: true,
      isolation: "runc",
      imageDigest: image,
    })
  })

  it("DOCKER-02: identity, capabilities, read-only root and the cgroup limits", async () => {
    const ref = refOf("dock", WS[0], 1)
    expect((await open(WS[0], 1)).status).toBe(200)
    await healthy(ref, 1)
    const facts = await sh(
      ref,
      1,
      [
        "echo uid=$(id -u)",
        "grep CapEff /proc/self/status",
        "grep CapBnd /proc/self/status",
        "cat /sys/fs/cgroup/memory.max",
        "cat /sys/fs/cgroup/memory.swap.max 2>/dev/null || echo noswapfile",
        "cat /sys/fs/cgroup/pids.max",
        "cat /sys/fs/cgroup/cpu.max",
        "touch /etc/kriya-probe 2>&1 || echo rootfs=readonly",
        "touch /workspace/ok && echo workspace=writable",
        "ls -la /var/run/docker.sock 2>&1 || echo nosocket",
        "cat /proc/1/environ 2>&1 | head -c 80 || true",
      ].join("; ")
    )
    report.facts = facts.out
    expect(facts.out).toContain("uid=1000")
    expect(facts.out).toMatch(/CapEff:\s+0000000000000000/)
    expect(facts.out).toContain("536870912")
    expect(facts.out).toMatch(/\n0\n|noswapfile/)
    expect(facts.out).toContain("256")
    expect(facts.out).toContain("50000 100000")
    expect(facts.out).toContain("rootfs=readonly")
    expect(facts.out).toContain("workspace=writable")
    expect(facts.out).toContain("nosocket")
    expect(facts.out).not.toContain(TOKEN)
    // The bounding set holds only the runner's seven capabilities
    const bnd = BigInt(`0x${/CapBnd:\s+([0-9a-f]+)/.exec(facts.out)![1]}`)
    const allowed = [0, 1, 3, 5, 6, 7, 12] // CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID NET_ADMIN
    const mask = allowed.reduce((m, bit) => m | (1n << BigInt(bit)), 0n)
    expect(bnd & ~mask).toBe(0n)
    report.capBnd = bnd.toString(16)
  }, 120_000)

  it("DOCKER-03: memory exhaustion ends in the sandbox, not the host; the runner survives", async () => {
    const ref = refOf("dock", WS[0], 1)
    const oom = await sh(
      ref,
      1,
      "python3 -c \"b = bytearray(900 * 1024 * 1024); print('allocated')\""
    )
    report.oom = { exitCode: oom.exitCode }
    expect(oom.exitCode).not.toBe(0)
    expect(oom.out).not.toContain("allocated")
    const after = await sh(ref, 1, "echo alive")
    expect(after.out).toContain("alive")
    const events = await docker(
      "inspect",
      "--format",
      "{{.State.OOMKilled}} {{.State.Running}}",
      ref
    )
    report.oomState = events
    expect(events.endsWith("true")).toBe(true)
  }, 120_000)

  it("DOCKER-04: a fork bomb meets the pids limit; the runner survives", async () => {
    const ref = refOf("dock", WS[0], 1)
    const bomb = await sh(
      ref,
      1,
      "bomb() { bomb | bomb & }; bomb; sleep 3; echo done",
      10
    )
    report.forkBomb = { exitCode: bomb.exitCode }
    const after = await sh(ref, 1, "echo alive")
    expect(after.out).toContain("alive")
    const pids = await docker("exec", ref, "cat", "/sys/fs/cgroup/pids.current")
    report.pidsAfter = pids
    expect(Number(pids)).toBeLessThan(256)
  }, 120_000)

  it("DOCKER-05: a newer fence restarts the sandbox: the older holder's command and access end", async () => {
    const ref = refOf("dock", WS[0], 1)
    const long = sh(ref, 1, "sleep 20; echo late > /workspace/late.txt", 60).catch(
      () => null
    )
    await new Promise((r) => setTimeout(r, 1000))
    expect((await open(WS[0], 2, { fresh: false })).status).toBe(200)
    await healthy(ref, 2)
    await long
    const check = await sh(
      ref,
      2,
      "ls /workspace; test -f /workspace/late.txt && echo LATE || echo none"
    )
    expect(check.out).toContain("ok")
    expect(check.out).toContain("none")
    const stale = await fetch(`${base}/v1/runner/${ref}/v1/health`, {
      headers: { [HEADERS.proxy]: proxyToken(KEY, ref, 1), [HEADERS.fence]: "1" },
    })
    expect(stale.status).toBe(409)
  }, 120_000)

  it("DOCKER-06: destroy removes the container and both volumes", async () => {
    const ref = refOf("dock", WS[1], 1)
    expect((await open(WS[1], 1)).status).toBe(200)
    await healthy(ref, 1)
    expect(
      (await signed("POST", "/v1/sandboxes/destroy", { ref, fence: 1 })).status
    ).toBe(200)
    expect(
      await docker("ps", "--all", "--filter", `name=${ref}`, "--format", "{{.Names}}")
    ).toBe("")
    expect(
      await docker("volume", "ls", "--filter", `name=${ref}`, "--format", "{{.Name}}")
    ).toBe("")
  }, 120_000)

  it("DOCKER-07: fail closed: runsc missing, an unpinned image or an ICC network means not ready", async () => {
    const probe = (policy: Partial<ConstructorParameters<typeof DockerRuntime>[0]>) =>
      new DockerRuntime({
        image,
        runtime: "runc",
        network: NETWORK,
        publish: true,
        requireHostFirewall: false,
        tmpMb: 256,
        ...policy,
      }).probe()
    const gvisor = await probe({ runtime: "runsc" })
    expect(gvisor.ready).toBe(false)
    expect(gvisor.reasons.join(" ")).toMatch(/runsc runtime isn't installed/)
    expect((await probe({ image: IMAGE_TAG })).reasons.join(" ")).toMatch(/isn't pinned/)
    expect((await probe({ network: "bridge" })).reasons.join(" ")).toMatch(
      /allows traffic between sandboxes/
    )
    expect((await probe({ requireHostFirewall: true })).reasons.join(" ")).toMatch(
      /KRIYA-SBX/
    )
    report.failClosed = { gvisor: gvisor.reasons }
  }, 120_000)
})
