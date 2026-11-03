import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { nodeKey } from "@/cloud-node/protocol"
import { fabricSweep } from "@/lib/cloud/fabric"
import { janitorSettings, workspaceJanitor } from "@/lib/cloud/janitor"
import {
  DEFAULT_POLICY,
  SelfHostedWorkspaceProvider,
} from "@/lib/cloud/providers/selfhosted"
import { TaskWorkspace, type CloudSettings } from "@/lib/cloud/session"

import { cloudDb } from "./db"
import { fixtureSource, memoryStore, textOf } from "./fake-provider"

// The local vertical slice (SH3/SH6; SELF_HOSTED_BENCHMARK_PLAN §5.1): the
// real control-plane code (TaskWorkspace → selfhosted provider → admission
// on PGlite) driving the real kriya-node process (cloud-node/index.ts, dev
// mode) on this machine's Docker with the real runner image. KRIYA_NODE_DOCKER=1
// only. Numbers are this laptop's (Docker Desktop, runc), recorded as a
// baseline, never as the VPS's.

const ON = process.env.KRIYA_NODE_DOCKER === "1"
const IMAGE_TAG = process.env.KRIYA_ISO_IMAGE ?? "kriya-runner:c9"
const NETWORK = "kriya-sbx-slice"
const SECRET = "v".repeat(43)
const PORT = 17071
const run = promisify(execFile)
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim()

const SETTINGS: CloudSettings = {
  image: IMAGE_TAG,
  size: "1c-1g",
  network: "offline",
  commandTimeoutSeconds: 120,
  maxRunning: 10,
  maxImportMb: 50,
  maxCheckpointMb: 10,
  costMicroUsdPerHour: null,
}

let agent: ChildProcess
let agentLog = ""
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  host: `${os.type()} ${os.arch()}`,
  runtime: "runc (Docker Desktop)",
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)])
}

describe.skipIf(!ON)(
  "CT-SH-SLICE: control plane → kriya-node process → Docker → runner",
  () => {
    let db: Awaited<ReturnType<typeof cloudDb>>
    let provider: () => SelfHostedWorkspaceProvider
    const store = memoryStore().store

    beforeAll(async () => {
      db = await cloudDb()
      const image = await docker("image", "inspect", "--format", "{{.Id}}", IMAGE_TAG)
      report.image = { tag: IMAGE_TAG, id: image }
      await docker(
        "network",
        "create",
        "--driver",
        "bridge",
        "--opt",
        "com.docker.network.bridge.enable_icc=false",
        NETWORK
      ).catch(() => "")
      agent = spawn(process.execPath, ["--import", "tsx", "cloud-node/index.ts"], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          KRIYA_NODE_ID: "slice",
          KRIYA_NODE_KEY: nodeKey(SECRET, "slice"),
          KRIYA_NODE_IMAGE: image,
          KRIYA_NODE_RUNTIME: "runc",
          KRIYA_NODE_NETWORK: NETWORK,
          KRIYA_NODE_DEV: "1",
          KRIYA_NODE_STATE_DIR: fs.mkdtempSync(
            path.join(os.tmpdir(), "kriya-slice-state-")
          ),
          KRIYA_NODE_DATA_DIR: os.tmpdir(),
          KRIYA_NODE_RESERVE_MEM_MB: "256",
          PORT: String(PORT),
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
      agent.stdout!.on("data", (d) => (agentLog += d))
      agent.stderr!.on("data", (d) => (agentLog += d))
      for (let i = 0; i < 100 && !agentLog.includes("listening"); i++)
        await new Promise((r) => setTimeout(r, 100))
      expect(agentLog).toContain("listening")
      provider = () =>
        new SelfHostedWorkspaceProvider({
          nodes: [{ id: "slice", url: `http://127.0.0.1:${PORT}` }],
          secret: SECRET,
          policy: {
            ...DEFAULT_POLICY,
            isolation: "trusted-runc",
            users: "*",
            maxWaitSeconds: 10,
          },
        })
      await fabricSweep(provider(), [])
      const [n] = (
        await db.pg.query<Record<string, unknown>>(
          "select healthy, isolation, reason, image_digest from kriya.exec_nodes"
        )
      ).rows
      report.node = n
      expect(n).toMatchObject({ healthy: true, isolation: "runc", image_digest: image })
    }, 120_000)

    afterAll(async () => {
      const refs = (
        await docker(
          "ps",
          "--all",
          "--filter",
          "label=kriya.node=1",
          "--format",
          "{{.Names}}"
        ).catch(() => "")
      )
        .split("\n")
        .filter((r) => r.startsWith("sh-slice-"))
      for (const ref of refs)
        await docker("rm", "--force", "--volumes", ref).catch(() => "")
      agent?.kill("SIGTERM")
      await docker("network", "rm", NETWORK).catch(() => "")
      report.agentLogLines = agentLog.split("\n").filter(Boolean).length
      report.agentLogHasToken = /KRIYA_RUNNER_TOKEN|Bearer /.test(agentLog)
      const out = path.join(process.cwd(), "screenshots", "cloud-execution", "SH6")
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(
        path.join(out, "selfhosted-docker-slice.json"),
        JSON.stringify(report, null, 2)
      )
    }, 120_000)

    it("SLICE-01: open a repository, run, checkpoint and pause; resume; close; measured", async () => {
      const t1 = await db.task("slice")
      const ws1 = new TaskWorkspace(provider(), t1, SETTINGS, {
        source: fixtureSource().source,
        store,
        healthMs: 30_000,
      })
      let t = performance.now()
      await ws1.open({ repo: "acme/web" })
      const openMs = performance.now() - t
      const c1 = await ws1.client()
      const facts = await c1.exec({
        command: "id -u; node --version; ls",
        timeoutSeconds: 30,
      })
      expect(facts.exitCode).toBe(0)
      const rtt: number[] = []
      for (let i = 0; i < 20; i++) {
        t = performance.now()
        await c1.exec({ command: "true", timeoutSeconds: 10 })
        rtt.push(performance.now() - t)
      }
      await c1.exec({ command: "echo slice > slice.txt", timeoutSeconds: 10 })
      t = performance.now()
      await ws1.close(null)
      const closeMs = performance.now() - t

      const t2 = await db.task("slice")
      const ws2 = new TaskWorkspace(provider(), t2, SETTINGS, {
        source: fixtureSource().source,
        store,
        healthMs: 30_000,
      })
      t = performance.now()
      const c2 = await ws2.client()
      const resumeMs = performance.now() - t
      expect(await textOf(c2, "slice.txt")).toBe("slice\n")
      await ws2.close(null)

      // The person closes it: the janitor removes the container and volumes
      await db.pg.query(
        "update kriya.workspaces set close_requested_at = now() where thread_id = $1",
        [t2.threadId]
      )
      const swept = await workspaceJanitor({
        provider: provider(),
        store,
        settings: { ...(await janitorSettings()), enabled: true, cloud: SETTINGS },
        reconcile: false,
        drain: [],
        healthMs: 30_000,
      })
      expect(swept?.closed).toBe(1)
      const left = await docker(
        "ps",
        "--all",
        "--filter",
        "label=kriya.node=1",
        "--format",
        "{{.Names}}"
      )
      expect(left.split("\n").filter((r) => r.startsWith("sh-slice-"))).toEqual([])
      const leases = (
        await db.pg.query("select status, reason from kriya.exec_leases order by id")
      ).rows
      report.latencyMs = {
        openWithImport: Math.round(openMs),
        checkpointAndPause: Math.round(closeMs),
        resume: Math.round(resumeMs),
        execRoundTrip: {
          n: rtt.length,
          p50: pct(rtt, 50),
          p95: pct(rtt, 95),
          max: Math.round(Math.max(...rtt)),
        },
      }
      report.leases = leases
      report.commandFacts = facts.stdout
      expect(leases.every((l) => (l as { status: string }).status === "released")).toBe(
        true
      )
    }, 300_000)
  }
)
