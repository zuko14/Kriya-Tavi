// Adapted from DeepSeek Harness @ ce7073d51254c26cd63b22a60835b8f948deb447 (MIT, NOTICE.md):
// subprocess/subprocess-local, shell/bash-local, spill/spill-local, guard/timeout-policy

import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { OWN_DIR, resolve, type Ctx } from "./paths"
import { RunnerError, type ExecEvent, type ExecRequest } from "./protocol"

// P1: a child never sees the runner's environment (its token, the limits),
// only these names plus what the request sets
export function childEnv(ctx: Ctx, extra: Record<string, string> = {}) {
  // CD-12: package managers find the registries through the proxy; the
  // firewall refuses any other way out
  const proxy: Record<string, string> = ctx.proxyUrl
    ? {
        HTTP_PROXY: ctx.proxyUrl,
        HTTPS_PROXY: ctx.proxyUrl,
        http_proxy: ctx.proxyUrl,
        https_proxy: ctx.proxyUrl,
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
      }
    : {}
  return {
    ...extra,
    ...proxy,
    PATH: ctx.path,
    HOME: ctx.home,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
  }
}

// CS-9: processes the command user may have at once (soft:hard). Set on
// each child with prlimit: /etc/security/limits.d applies only to PAM
// logins, and commands start with a plain uid switch
export const NPROC = "256:512"

export const commandFor = (ctx: Pick<Ctx, "runAs">, command: string, args: string[]) =>
  ctx.runAs
    ? (["prlimit", [`--nproc=${NPROC}`, "--", command, ...args]] as const)
    : ([command, args] as const)

// Every child leads its own process group, so one kill reaches its children
export function spawnAs(
  ctx: Ctx,
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
) {
  const [file, argv] = commandFor(ctx, command, args)
  return spawn(file, [...argv], {
    cwd: options.cwd ?? ctx.root,
    env: (options.env ?? childEnv(ctx)) as NodeJS.ProcessEnv,
    detached: true,
    uid: ctx.runAs?.uid,
    gid: ctx.runAs?.gid,
  })
}

// SIGTERM to the whole group, SIGKILL after the grace
export function killGroup(child: ChildProcess, graceMs: number) {
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name)
    } catch {
      // Already gone
    }
  }
  signal("SIGTERM")
  setTimeout(() => signal("SIGKILL"), graceMs)
}

// P2: the whole text while it's small; past the cap only a head and a tail
// stay in memory, and the full output is in the log file
class Capture {
  private full = ""
  private head = ""
  private tail = ""
  private total = 0
  private readonly limits: Ctx["limits"]
  truncated = false
  streamed = 0

  constructor(ctx: Ctx) {
    this.limits = ctx.limits
  }

  add(text: string) {
    const { outputMemoryBytes, headBytes, tailBytes } = this.limits
    this.total += text.length
    if (this.truncated) {
      this.tail = (this.tail + text).slice(-tailBytes)
      return
    }
    this.full += text
    if (this.full.length <= outputMemoryBytes) return
    this.truncated = true
    this.head = this.full.slice(0, headBytes)
    this.tail = this.full.slice(-tailBytes)
    this.full = ""
  }

  text(logPath: string) {
    if (!this.truncated) return this.full
    const dropped = this.total - this.head.length - this.tail.length
    return `${this.head}\n[output truncated: ${dropped} characters left out; full log at ${logPath}]\n${this.tail}`
  }
}

export async function runCommand(
  ctx: Ctx,
  request: ExecRequest,
  emit: (event: ExecEvent) => void,
  signal: AbortSignal
) {
  const cwd = await resolve(ctx, request.cwd)
  if (!(await fs.promises.stat(cwd.abs).catch(() => null))?.isDirectory()) {
    throw new RunnerError(400, `${request.cwd}: not a folder in the workspace`)
  }
  const logPath = `${OWN_DIR}/logs/${Date.now()}-${randomUUID().slice(0, 8)}.log`
  const log = fs.createWriteStream(path.join(ctx.root, logPath))
  const started = Date.now()
  // P6: each command declares its timeout, bounded by the setting
  const timeout = Math.min(request.timeoutSeconds, ctx.limits.commandTimeoutSeconds)

  return new Promise<ExecEvent & { type: "end" }>((done) => {
    const child = spawnAs(ctx, "bash", ["-lc", request.command], {
      cwd: cwd.abs,
      env: childEnv(ctx, request.env),
    })
    child.stdin.end()
    const captures = { stdout: new Capture(ctx), stderr: new Capture(ctx) }
    let timedOut = false
    let finished = false

    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8")
      child[stream].on("data", (text: string) => {
        log.write(text)
        const capture = captures[stream]
        capture.add(text)
        const room = ctx.limits.outputMemoryBytes - capture.streamed
        if (room > 0) {
          const part = text.slice(0, room)
          capture.streamed += part.length
          emit({ type: "out", stream, text: part })
        }
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, ctx.killGraceMs)
    }, timeout * 1000)
    const onAbort = () => killGroup(child, ctx.killGraceMs)
    signal.addEventListener("abort", onAbort, { once: true })

    const finish = (exitCode: number | null, exitSignal: string | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      const durationMs = Date.now() - started
      // The end event names the full log, so it waits until the log is on disk
      log.end(() =>
        done({
          type: "end",
          exitCode,
          signal: exitSignal,
          timedOut,
          durationMs,
          stdout: captures.stdout.text(logPath),
          stderr: captures.stderr.text(logPath),
          truncated: captures.stdout.truncated || captures.stderr.truncated,
          logPath,
        })
      )
    }

    // One-shot commands: whatever the command left running in its group is
    // stopped when it exits (no persistent processes in v1, CD-17)
    child.on("exit", (code, exitSignal) => {
      killGroup(child, ctx.killGraceMs)
      // A process outside the group may still hold the pipes
      setTimeout(() => finish(code, exitSignal), ctx.killGraceMs + 100)
    })
    child.on("close", (code, exitSignal) => finish(code, exitSignal))
    child.on("error", () => finish(null, null))
  })
}
