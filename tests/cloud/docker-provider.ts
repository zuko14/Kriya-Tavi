import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { Opened, WorkspaceProvider, WorkspaceSpec } from "@/lib/cloud/provider"

// The real runner image (runner/Dockerfile) as a WorkspaceProvider on this
// machine's Docker, for the isolation probes (C9, CT-ISO-*). Not a product
// provider: containers share the host kernel, so this shows what the image
// itself guarantees (the user split, the token's reach, its egress firewall
// and proxy, its process limits), not the provider's VM boundary. The token, limits and generation go to the
// container through the docker CLI's environment, never its arguments.

const run = promisify(execFile)
const LABEL = "kriya.iso"

const docker = async (
  args: string[],
  env: Record<string, string | undefined> = process.env
) =>
  (
    await run("docker", args, {
      env: env as NodeJS.ProcessEnv,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim()

export const dockerAvailable = () =>
  docker(["info", "--format", "{{.ServerVersion}}"]).then(
    () => true,
    () => false
  )

export const imageExists = (image: string) =>
  docker(["image", "inspect", image]).then(
    () => true,
    () => false
  )

export class DockerProvider implements WorkspaceProvider {
  readonly name = "local" as const

  // netAdmin false: a sandbox without the capability (the fail-closed probe)
  constructor(
    private readonly image: string,
    private readonly options: { netAdmin?: boolean } = {}
  ) {}

  async create(spec: WorkspaceSpec): Promise<Opened> {
    const ref = `kriya-iso-${spec.workspaceId}-${spec.generation}`
    await docker(
      [
        "run",
        "--detach",
        "--name",
        ref,
        "--label",
        `${LABEL}=${spec.workspaceId}`,
        "--publish",
        "127.0.0.1::10000",
        // The runner installs its egress firewall (CD-12); commands never
        // hold this capability (they start as uid 1000)
        ...(this.options.netAdmin === false ? [] : ["--cap-add", "NET_ADMIN"]),
        // The sandbox's own outer bound beside the per-command nproc (CS-9)
        "--pids-limit",
        "2048",
        "--env",
        "KRIYA_RUNNER_TOKEN",
        "--env",
        "KRIYA_RUNNER_LIMITS",
        "--env",
        "KRIYA_RUNNER_GENERATION",
        this.image,
      ],
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KRIYA_RUNNER_TOKEN: spec.runnerToken,
        KRIYA_RUNNER_LIMITS: JSON.stringify(spec.limits),
        KRIYA_RUNNER_GENERATION: String(spec.generation),
      }
    )
    return { ref, runnerUrl: await this.url(ref) }
  }

  private async url(ref: string) {
    const port = (await docker(["port", ref, "10000/tcp"])).split("\n")[0]
    return `http://${port}`
  }

  async resume(ref: string): Promise<Opened | null> {
    const running = await docker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      ref,
    ]).catch(() => null)
    return running === "true" ? { ref, runnerUrl: await this.url(ref) } : null
  }

  async pause() {}

  async destroy(ref: string) {
    await docker(["rm", "--force", ref]).catch(() => {})
  }

  async extend() {}

  // The host's address as the container sees it (Docker Desktop's
  // host.docker.internal), resolved as root in the container: probes then
  // try it by IP, past the command user's missing resolver
  async hostAddress(ref: string) {
    const out = await docker([
      "exec",
      ref,
      "getent",
      "ahostsv4",
      "host.docker.internal",
    ]).catch(() => "")
    return out.split(/\s+/)[0] || null
  }

  async list() {
    const out = await docker([
      "ps",
      "--all",
      "--filter",
      `label=${LABEL}`,
      "--format",
      "{{.Names}} {{.State}}",
    ])
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, state] = line.split(" ")
        return {
          ref,
          workspaceId: ref.replace(/^kriya-iso-/, "").replace(/-\d+$/, ""),
          running: state === "running",
        }
      })
  }
}
