import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { RunnerClient } from "@/lib/cloud/client"
import type { FileStore } from "@/lib/files"
import type {
  Opened,
  RepoSource,
  WorkspaceProvider,
  WorkspaceSpec,
} from "@/lib/cloud/provider"
import { createRunner } from "@/runner"

import { packDirectory } from "./tar"

// An in-memory WorkspaceProvider (TEST_STRATEGY §1): each sandbox is the
// real runner in-process over a temporary directory. Knobs simulate a
// sandbox the provider lost, a resume that fails, and a runner that never
// answers.

type Sandbox = { runner: Awaited<ReturnType<typeof createRunner>>; root: string }

// Nothing listens on port 9 (discard): health probes there fail
const DEAD = "http://127.0.0.1:9"

export class FakeProvider implements WorkspaceProvider {
  readonly name = "local" as const
  calls: { op: string; ref?: string; generation?: number }[] = []
  sandboxes = new Map<string, Sandbox>()
  resumeFails = false
  unhealthy = false
  // Runs inside create, before the sandbox exists (to look at the database)
  beforeCreate: (() => Promise<void>) | null = null

  async create(spec: WorkspaceSpec): Promise<Opened> {
    this.calls.push({ op: "create", generation: spec.generation })
    await this.beforeCreate?.()
    const ref = `fake-${spec.workspaceId}-${spec.generation}`
    if (this.unhealthy) return { ref, runnerUrl: DEAD }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-fake-ws-"))
    const runner = await createRunner({
      root,
      token: spec.runnerToken,
      generation: spec.generation,
      limits: spec.limits,
      home: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-fake-home-")),
      path: process.env.PATH ?? "/usr/bin:/bin",
      killGraceMs: 200,
    })
    this.sandboxes.set(ref, { runner, root })
    return { ref, runnerUrl: runner.url }
  }

  async resume(ref: string): Promise<Opened | null> {
    this.calls.push({ op: "resume", ref })
    if (this.resumeFails) throw new Error("provider: resume failed")
    const sandbox = this.sandboxes.get(ref)
    if (!sandbox) return null
    return { ref, runnerUrl: this.unhealthy ? DEAD : sandbox.runner.url }
  }

  async pause(ref: string) {
    this.calls.push({ op: "pause", ref })
  }

  async destroy(ref: string) {
    this.calls.push({ op: "destroy", ref })
    await this.sandboxes.get(ref)?.runner.close()
    this.sandboxes.delete(ref)
  }

  async extend(ref: string) {
    this.calls.push({ op: "extend", ref })
  }

  async list() {
    return [...this.sandboxes.keys()].map((ref) => ({
      ref,
      workspaceId: ref.split("-").slice(1, -1).join("-"),
      running: true,
    }))
  }

  // The provider lost every sandbox (destroyed after pausedHours, or gone)
  async forget() {
    for (const sandbox of this.sandboxes.values()) await sandbox.runner.close()
    this.sandboxes.clear()
  }

  async closeAll() {
    await this.forget()
  }

  ops() {
    return this.calls.map((c) => c.op)
  }
}

export const BASE_SHA = "1".repeat(40)
export const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "cloud", "repo")

// The fixture repository at any ref, as GitHub would serve it
export function fixtureSource() {
  const calls: { repo: string; ref: string | null }[] = []
  const source: RepoSource = {
    async tarball(_userId, repo, ref) {
      calls.push({ repo, ref })
      return {
        sha: ref && /^[0-9a-f]{40}$/.test(ref) ? ref : BASE_SHA,
        body: packDirectory(FIXTURE),
        bytes: null,
      }
    },
  }
  return { source, calls }
}

// A text file's contents through the runner client
export async function textOf(client: RunnerClient, path: string) {
  const result = await client.read({ path })
  if (!("text" in result)) throw new Error(`${path} isn't text`)
  return result.text
}

// Checkpoint uploads in memory
export function memoryStore() {
  const objects = new Map<string, Buffer>()
  const store: FileStore = {
    uploadUrl: async () => "",
    read: async (p) => objects.get(p) ?? null,
    write: async (p, bytes) => void objects.set(p, Buffer.from(bytes)),
    signedUrl: async () => "",
    remove: async (paths) => paths.forEach((p) => objects.delete(p)),
  }
  return { store, objects }
}
