import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { Probe, SandboxRuntime, SandboxSpec } from "./runtime"

// Docker with gVisor (CD-30, CD-34; SELF_HOSTED_THREAT_MODEL §4): one
// container per workspace generation, from one pinned image, on a bridge
// network with inter-container traffic off and host firewall rules that
// keep sandboxes away from the host and private ranges. Every flag that
// matters for isolation is built by dockerCreateArgs, a pure function the
// security tests read (CT-SH-SEC-01…05). The docker CLI is called with an
// argument array, never a shell; the runner's token reaches the container
// through the CLI process's environment, never its arguments.

const run = promisify(execFile)

export type DockerPolicy = {
  // Pinned: repo@sha256:… or an image id sha256:…
  image: string
  // runsc unless the owner runs a trusted-only node (CD-30)
  runtime: "runsc" | "runc"
  network: string
  // Developer machines only: Docker Desktop can't route to container IPs
  publish: boolean
  // Checked at start; dev machines can't install host rules
  requireHostFirewall: boolean
  tmpMb: number
}

const LABEL = "kriya.node"
// The runner needs these inside its own sandbox: switching to the command
// user (SETUID, SETGID), owning what it writes for that user (CHOWN, FOWNER,
// DAC_OVERRIDE), signalling its process groups (KILL) and installing the
// egress firewall (NET_ADMIN, CD-12). Commands run as uid 1000 and hold none
export const RUNNER_CAPS = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "KILL",
  "SETUID",
  "SETGID",
  "NET_ADMIN",
]

export const PINNED_IMAGE = /^([a-z0-9./_:-]+@)?sha256:[0-9a-f]{64}$/

// cloud-node/host-setup.sh's rules, read from `iptables -S`: the jump from
// DOCKER-USER, and drops for metadata and every private range in the chain
export function hostFirewallInstalled(dockerUser: string, chain: string) {
  return (
    /-A DOCKER-USER .*-j KRIYA-SBX/.test(dockerUser) &&
    [
      "169.254.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "127.0.0.0/8",
    ].every((net) => chain.includes(`-d ${net} -j DROP`))
  )
}

export function dockerCreateArgs(spec: SandboxSpec, policy: DockerPolicy) {
  return [
    "create",
    "--name",
    spec.ref,
    "--label",
    `${LABEL}=1`,
    "--label",
    `kriya.workspace=${spec.workspaceId}`,
    "--runtime",
    policy.runtime,
    "--network",
    policy.network,
    ...(policy.publish ? ["--publish", "127.0.0.1::10000"] : []),
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${policy.tmpMb}m`,
    "--tmpfs",
    "/run:rw,nosuid,nodev,noexec,size=16m",
    "--mount",
    `type=volume,src=${spec.ref}-ws,dst=/workspace`,
    "--mount",
    `type=volume,src=${spec.ref}-home,dst=/home/kriya`,
    "--cap-drop",
    "ALL",
    ...RUNNER_CAPS.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(spec.pids),
    "--memory",
    `${spec.memMb}m`,
    // No swap: memory pressure ends in the sandbox's own OOM, not the host's
    "--memory-swap",
    `${spec.memMb}m`,
    "--cpus",
    (spec.cpuMillis / 1000).toFixed(2),
    "--ulimit",
    "nofile=4096:8192",
    "--restart",
    "no",
    "--stop-timeout",
    "10",
    "--hostname",
    "workspace",
    "--workdir",
    "/app",
    ...Object.keys(spec.env)
      .sort()
      .flatMap((name) => ["--env", name]),
    policy.image,
    "node",
    "--import",
    "tsx",
    "runner/index.ts",
  ]
}

export class DockerRuntime implements SandboxRuntime {
  constructor(private readonly policy: DockerPolicy) {}

  private async docker(args: string[], env: Record<string, string> = {}) {
    const { stdout } = await run("docker", args, {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME,
        ...env,
      } as unknown as NodeJS.ProcessEnv,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    })
    return stdout.trim()
  }

  private ok = (args: string[]) =>
    this.docker(args).then(
      (out) => out,
      () => null
    )

  async probe(): Promise<Probe> {
    const reasons: string[] = []
    if (!PINNED_IMAGE.test(this.policy.image))
      reasons.push("the image isn't pinned by digest")
    const info = await this.ok([
      "info",
      "--format",
      "{{json .Runtimes}}|{{.CgroupVersion}}",
    ])
    let isolation: Probe["isolation"] = null
    if (!info) reasons.push("docker isn't reachable")
    else {
      const [runtimes, cgroup] = info.split("|")
      if (!runtimes.includes(`"${this.policy.runtime}"`))
        reasons.push(`the ${this.policy.runtime} runtime isn't installed`)
      else isolation = this.policy.runtime === "runsc" ? "gvisor" : "runc"
      if (cgroup !== "2") reasons.push("cgroup v2 isn't in use")
    }
    const imageDigest = await this.ok([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      this.policy.image,
    ])
    if (!imageDigest) reasons.push("the image isn't present")
    const icc = await this.ok([
      "network",
      "inspect",
      "--format",
      '{{index .Options "com.docker.network.bridge.enable_icc"}}',
      this.policy.network,
    ])
    if (icc !== "false")
      reasons.push(
        `network ${this.policy.network} is missing or allows traffic between sandboxes`
      )
    if (this.policy.requireHostFirewall) {
      // cloud-node/host-setup.sh installs the chain; without it a sandbox
      // could reach the host and private ranges (fail closed, CD-34)
      const rules = async (chain: string) =>
        run("iptables", ["-S", chain]).then(
          (r) => r.stdout,
          () => ""
        )
      if (!hostFirewallInstalled(await rules("DOCKER-USER"), await rules("KRIYA-SBX")))
        reasons.push("the host firewall chain KRIYA-SBX isn't installed")
    }
    return {
      ready: reasons.length === 0,
      reasons,
      isolation,
      imageDigest:
        imageDigest && /^sha256:[0-9a-f]{64}$/.test(imageDigest) ? imageDigest : null,
    }
  }

  async create(spec: SandboxSpec) {
    await this.docker(dockerCreateArgs(spec, this.policy), spec.env)
    await this.docker(["start", spec.ref])
  }

  async start(ref: string) {
    await this.docker(["start", ref])
  }

  async restart(ref: string) {
    await this.docker(["restart", "--time", "5", ref])
  }

  async stop(ref: string) {
    await this.ok(["stop", "--time", "10", ref])
  }

  async remove(ref: string) {
    await this.ok(["rm", "--force", "--volumes", ref])
    await this.ok(["volume", "rm", "--force", `${ref}-ws`, `${ref}-home`])
  }

  async inspect(ref: string) {
    const out = await this.ok(["inspect", "--format", "{{.State.Running}}", ref])
    return out === null ? null : { running: out === "true" }
  }

  async address(ref: string) {
    if (this.policy.publish) {
      const port = await this.ok(["port", ref, "10000/tcp"])
      return port ? `http://${port.split("\n")[0]}` : null
    }
    const ip = await this.ok([
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${this.policy.network}").IPAddress}}`,
      ref,
    ])
    return ip && /^[\d.]+$/.test(ip) ? `http://${ip}:10000` : null
  }

  async list() {
    const out = await this.ok([
      "ps",
      "--all",
      "--filter",
      `label=${LABEL}=1`,
      "--format",
      "{{.Names}} {{.State}}",
    ])
    return (out ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, state] = line.split(" ")
        return { ref, running: state === "running" }
      })
  }

  // shortcut: du over each sandbox's two volumes every sweep; exact quotas
  // need XFS project quotas on the Docker data disk (runbook §2, OA-2)
  async usage() {
    const sizes = new Map<string, number>()
    for (const { ref } of await this.list()) {
      let bytes = 0
      for (const volume of [`${ref}-ws`, `${ref}-home`]) {
        const mount = await this.ok([
          "volume",
          "inspect",
          "--format",
          "{{.Mountpoint}}",
          volume,
        ])
        if (!mount?.startsWith("/")) continue
        const du = await run("du", ["-sx", "--block-size=1", mount]).then(
          (r) => Number.parseInt(r.stdout, 10),
          () => 0
        )
        bytes += du || 0
      }
      sizes.set(ref, bytes)
    }
    return sizes
  }
}
