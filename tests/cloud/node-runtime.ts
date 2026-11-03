import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Probe, SandboxRuntime, SandboxSpec } from "@/cloud-node/runtime"
import { createRunner } from "@/runner"

// A SandboxRuntime for tests (never shipped): each sandbox is the real
// runner in-process over a temporary directory, so the real node agent, the
// real proxy and the real runner protocol are exercised end to end without
// Docker. It isolates nothing and says so (isolation "runc"), so only a
// trusted-runc policy places sandboxes on it.

type Box = {
  spec: SandboxSpec
  root: string
  runner: Awaited<ReturnType<typeof createRunner>> | null
}

export class InProcessRuntime implements SandboxRuntime {
  readonly boxes = new Map<string, Box>()
  readonly calls: string[] = []
  readonly base = fs.mkdtempSync(path.join(os.tmpdir(), "kriya-node-rt-"))
  probeResult: Probe = { ready: true, reasons: [], isolation: "runc", imageDigest: null }
  failCreate = false
  sizes = new Map<string, number>()

  async probe() {
    return this.probeResult
  }

  private async boot(box: Box) {
    const generation = Number(box.spec.env.KRIYA_RUNNER_GENERATION)
    box.runner = await createRunner({
      root: path.join(box.root, "workspace"),
      home: path.join(box.root, "home"),
      token: box.spec.env.KRIYA_RUNNER_TOKEN,
      generation,
      limits: JSON.parse(box.spec.env.KRIYA_RUNNER_LIMITS),
      path: process.env.PATH ?? "/usr/bin:/bin",
      killGraceMs: 200,
    })
  }

  async create(spec: SandboxSpec) {
    this.calls.push(`create ${spec.ref}`)
    if (this.failCreate) throw new Error("runtime: create failed")
    const root = path.join(this.base, spec.ref)
    fs.mkdirSync(path.join(root, "workspace"), { recursive: true })
    fs.mkdirSync(path.join(root, "home"), { recursive: true })
    const box: Box = { spec, root, runner: null }
    this.boxes.set(spec.ref, box)
    await this.boot(box)
  }

  async start(ref: string) {
    this.calls.push(`start ${ref}`)
    const box = this.boxes.get(ref)
    if (!box) throw new Error("no such sandbox")
    if (!box.runner) await this.boot(box)
  }

  async restart(ref: string) {
    this.calls.push(`restart ${ref}`)
    await this.stop(ref)
    await this.start(ref)
  }

  async stop(ref: string) {
    this.calls.push(`stop ${ref}`)
    const box = this.boxes.get(ref)
    await box?.runner?.close()
    if (box) box.runner = null
  }

  async remove(ref: string) {
    this.calls.push(`remove ${ref}`)
    await this.stop(ref)
    const box = this.boxes.get(ref)
    if (box) fs.rmSync(box.root, { recursive: true, force: true })
    this.boxes.delete(ref)
  }

  async inspect(ref: string) {
    const box = this.boxes.get(ref)
    return box ? { running: !!box.runner } : null
  }

  async address(ref: string) {
    return this.boxes.get(ref)?.runner?.url ?? null
  }

  async list() {
    return [...this.boxes.entries()].map(([ref, box]) => ({ ref, running: !!box.runner }))
  }

  async usage() {
    return this.sizes
  }

  envOf(ref: string) {
    return this.boxes.get(ref)?.spec.env
  }

  async closeAll() {
    for (const ref of [...this.boxes.keys()]) await this.remove(ref)
    fs.rmSync(this.base, { recursive: true, force: true })
  }
}
