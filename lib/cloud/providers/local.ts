import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  WorkspaceProviderError,
  type Opened,
  type WorkspaceProvider,
  type WorkspaceSpec,
} from "@/lib/cloud/provider"

// The `local` provider (CD-07): the runner as a child process over a
// directory on this machine, for tests and the isolated verify stack only.
// User code runs with this machine's rights, so it refuses to start unless
// KRIYA_WORKSPACE_LOCAL=1 and the database is local (the verify:guard rule).

export function localAllowed() {
  if (process.env.KRIYA_WORKSPACE_LOCAL !== "1") return false
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname
    return host === "127.0.0.1" || host === "localhost"
  } catch {
    return false
  }
}

const BASE = path.join(os.tmpdir(), "kriya-local-workspaces")
const REF = /^local-[0-9a-f-]{36}-\d{1,9}$/
const START_MS = 20_000

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly name = "local" as const
  private running = new Map<string, { child: ChildProcess; url: string }>()

  rootOf(ref: string) {
    if (!REF.test(ref)) throw new WorkspaceProviderError("Not a local workspace.")
    return path.join(BASE, ref)
  }

  private guard() {
    if (!localAllowed()) {
      throw new WorkspaceProviderError(
        "The local workspace provider runs only on the verify stack."
      )
    }
  }

  async create(spec: WorkspaceSpec) {
    this.guard()
    const ref = `local-${spec.workspaceId}-${spec.generation}`
    const root = this.rootOf(ref)
    await fs.mkdir(path.join(root, "workspace"), { recursive: true })
    await fs.mkdir(path.join(root, "home"), { recursive: true })
    return this.start(ref, spec)
  }

  async resume(ref: string, spec: WorkspaceSpec): Promise<Opened | null> {
    this.guard()
    const exists = await fs.stat(this.rootOf(ref)).then(
      () => true,
      () => false
    )
    if (!exists) return null
    const live = this.running.get(ref)
    return live ? { ref, runnerUrl: live.url } : this.start(ref, spec)
  }

  // Stops the process; the directory stays, like a paused sandbox's disk
  async pause(ref: string) {
    const live = this.running.get(ref)
    if (!live) return
    this.running.delete(ref)
    await new Promise<void>((done) => {
      if (live.child.exitCode !== null) return done()
      live.child.once("exit", () => done())
      live.child.kill("SIGTERM")
    })
  }

  async destroy(ref: string) {
    await this.pause(ref)
    await fs.rm(this.rootOf(ref), { recursive: true, force: true })
  }

  async extend() {}

  async list() {
    const refs = await fs.readdir(BASE).catch(() => [] as string[])
    return refs
      .filter((ref) => REF.test(ref))
      .map((ref) => ({
        ref,
        workspaceId: ref.slice("local-".length, ref.lastIndexOf("-")),
        running: this.running.has(ref),
      }))
  }

  // The runner gets its token, limits and paths and nothing else of the
  // worker's environment (no DATABASE_URL, no secret)
  private start(ref: string, spec: WorkspaceSpec) {
    const root = this.rootOf(ref)
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      KRIYA_RUNNER_TOKEN: spec.runnerToken,
      KRIYA_RUNNER_LIMITS: JSON.stringify(spec.limits),
      KRIYA_RUNNER_GENERATION: String(spec.generation),
      KRIYA_RUNNER_ROOT: path.join(root, "workspace"),
      KRIYA_RUNNER_HOME: path.join(root, "home"),
      KRIYA_RUNNER_PATH: process.env.PATH ?? "/usr/bin:/bin",
      KRIYA_RUNNER_HOST: "127.0.0.1",
      PORT: "0",
    }
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(process.cwd(), "runner", "index.ts")],
      {
        cwd: process.cwd(),
        env: env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    return new Promise<Opened>((done, fail) => {
      let output = ""
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        fail(new WorkspaceProviderError("The local workspace runner didn't start."))
      }, START_MS)
      child.stdout?.setEncoding("utf8")
      child.stdout?.on("data", (text: string) => {
        output += text
        const port = output.match(/listening on (\d+)/)?.[1]
        if (!port) return
        clearTimeout(timer)
        const url = `http://127.0.0.1:${port}`
        this.running.set(ref, { child, url })
        done({ ref, runnerUrl: url })
      })
      child.stderr?.resume()
      child.once("exit", () => {
        clearTimeout(timer)
        if (this.running.get(ref)?.child === child) this.running.delete(ref)
        fail(new WorkspaceProviderError("The local workspace runner stopped."))
      })
    })
  }
}
