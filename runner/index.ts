import { createHash, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { z } from "zod"

import { changes, changeSetFiles, checkpoint, restore } from "./changes"
import { applyFirewall, startRegistryProxy } from "./egress"
import { runCommand } from "./exec"
import { applyPatch, editFile, readFile, writeFile } from "./files"
import { importArchive } from "./import"
import { OWN_DIR, type Ctx } from "./paths"
import {
  changesRequest,
  editRequest,
  execRequest,
  filesRequest,
  limitsSchema,
  listRequest,
  patchRequest,
  readRequest,
  RUNNER_VERSION,
  RunnerError,
  searchRequest,
  writeRequest,
  type ExecEvent,
} from "./protocol"
import { list, search } from "./search"

// The runner (track C, docs/cloud-execution/ARCHITECTURE.md §1): runs inside
// one workspace's sandbox and does the work behind the workspace_* tools on
// /workspace. No database, no Kriya secret: one bearer token, derived for
// this workspace and generation by the worker (CD-09).

export type RunnerOptions = {
  root: string
  token: string
  generation: number
  limits?: unknown
  port?: number
  host?: string
  runAs?: { uid: number; gid: number }
  home: string
  path: string
  killGraceMs?: number
}

const digest = (value: string) => createHash("sha256").update(value).digest()

// Reads the whole body, or refuses it past `max` (after draining, so the
// client gets the answer instead of a reset)
function readBody(req: http.IncomingMessage, max: number) {
  return new Promise<Buffer>((done, fail) => {
    if (Number(req.headers["content-length"] ?? 0) > max) {
      req.resume()
      req.on("end", () => fail(new RunnerError(413, "the request body is too large")))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= max) chunks.push(chunk)
    })
    req.on("end", () =>
      size > max
        ? fail(new RunnerError(413, "the request body is too large"))
        : done(Buffer.concat(chunks))
    )
    req.on("error", fail)
  })
}

async function readJson<T extends z.ZodType>(
  req: http.IncomingMessage,
  ctx: Ctx,
  schema: T
) {
  const body = await readBody(req, ctx.limits.bodyBytes)
  let value: unknown
  try {
    value = body.length ? JSON.parse(body.toString("utf8")) : {}
  } catch {
    throw new RunnerError(400, "the request body isn't JSON")
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RunnerError(400, `${issue.path.join(".") || "body"}: ${issue.message}`)
  }
  return parsed.data as z.infer<T>
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Ctx
) => Promise<void>

const json =
  <T extends z.ZodType>(
    schema: T,
    work: (ctx: Ctx, body: z.infer<T>) => Promise<unknown>
  ): Handler =>
  async (req, res, ctx) =>
    sendJson(res, 200, await work(ctx, await readJson(req, ctx, schema)))

const ROUTES: Record<string, Handler> = {
  "/v1/exec": async (req, res, ctx) => {
    const request = await readJson(req, ctx, execRequest)
    const abort = new AbortController()
    res.on("close", () => {
      if (!res.writableFinished) abort.abort()
    })
    let started = false
    const emit = (event: ExecEvent) => {
      if (res.destroyed) return
      if (!started) {
        res.writeHead(200, { "content-type": "application/x-ndjson" })
        started = true
      }
      res.write(`${JSON.stringify(event)}\n`)
    }
    // A bad cwd throws before anything is written, so it gets its own status
    const end = await runCommand(ctx, request, emit, abort.signal)
    emit(end)
    res.end()
  },
  "/v1/read": json(readRequest, readFile),
  "/v1/write": json(writeRequest, writeFile),
  "/v1/edit": json(editRequest, editFile),
  "/v1/patch": json(patchRequest, (ctx, body) => applyPatch(ctx, body.patch)),
  "/v1/list": json(listRequest, list),
  "/v1/search": json(searchRequest, search),
  "/v1/changes": json(changesRequest, (ctx, body) => changes(ctx, body.maxDiffBytes)),
  "/v1/files": json(filesRequest, (ctx, body) => changeSetFiles(ctx, body.changeSetId)),
  "/v1/import": async (req, res, ctx) => {
    const base = req.headers["x-kriya-base"]
    if (base !== undefined && !/^[0-9a-f]{40}$/.test(String(base))) {
      throw new RunnerError(400, "X-Kriya-Base must be a commit sha")
    }
    const strip = req.headers["x-kriya-strip"] === "1" ? 1 : 0
    const body = await readBody(req, ctx.limits.importBytes)
    sendJson(
      res,
      200,
      await importArchive(ctx, body, { strip, base: base ? String(base) : null })
    )
  },
  "/v1/restore": async (req, res, ctx) =>
    sendJson(
      res,
      200,
      await restore(ctx, await readBody(req, ctx.limits.checkpointBytes))
    ),
  "/v1/checkpoint": async (req, res, ctx) => {
    req.resume()
    const result = await checkpoint(ctx)
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-kriya-sha256": result.sha256,
      "x-kriya-changes": JSON.stringify(result.changes),
    })
    res.end(result.patch)
  },
}

export async function createRunner(options: RunnerOptions) {
  if (options.token.length < 32)
    throw new Error("the runner token needs at least 32 characters")
  const root = await fs.realpath(options.root)
  await fs.mkdir(path.join(root, OWN_DIR, "logs"), { recursive: true })
  const ctx: Ctx = {
    root,
    limits: limitsSchema.parse(options.limits ?? {}),
    generation: options.generation,
    runAs: options.runAs,
    home: options.home,
    path: options.path,
    killGraceMs: options.killGraceMs ?? 5000,
    seen: new Map(),
  }
  // CD-12, as root in the image: the firewall before anything can run, then
  // the proxy. A failure stops the runner (the workspace never starts)
  const proxy = options.runAs
    ? (await applyFirewall(options.runAs.uid),
      await startRegistryProxy({ network: ctx.limits.network }))
    : null
  ctx.proxyUrl = proxy?.url
  const expected = digest(`Bearer ${options.token}`)

  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url ?? "/", "http://runner").pathname
    if (req.method === "GET" && route === "/v1/health") {
      return sendJson(res, 200, {
        ok: true,
        version: RUNNER_VERSION,
        generation: ctx.generation,
      })
    }
    if (!timingSafeEqual(digest(String(req.headers.authorization ?? "")), expected)) {
      req.resume()
      return sendJson(res, 401, { error: "unauthorized" })
    }
    const handler = req.method === "POST" ? ROUTES[route] : undefined
    if (!handler) {
      req.resume()
      return sendJson(res, 404, { error: "not found" })
    }
    try {
      await handler(req, res, ctx)
    } catch (error) {
      if (res.headersSent) return void res.end()
      if (error instanceof RunnerError)
        return sendJson(res, error.status, { error: error.message })
      // The message only: request bodies and file contents never reach the log
      console.error(`[kriya-runner] ${route}: ${(error as Error).message}`)
      sendJson(res, 500, { error: "the runner failed; try again" })
    }
  })
  await new Promise<void>((listening) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", listening)
  )
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections()
        server.close(() => closed())
      }).then(() => proxy?.close()),
  }
}

// In the image: root inside the VM (CD-21), commands as `kriya` (uid 1000)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.KRIYA_RUNNER_TOKEN ?? ""
  const limits = process.env.KRIYA_RUNNER_LIMITS
  const generation = Number.parseInt(process.env.KRIYA_RUNNER_GENERATION ?? "", 10)
  // Out of this process's environment before anything else runs
  delete process.env.KRIYA_RUNNER_TOKEN
  delete process.env.KRIYA_RUNNER_LIMITS
  let parsedLimits: unknown
  try {
    parsedLimits = limitsSchema.parse(JSON.parse(limits ?? "{}"))
  } catch {
    console.error("[kriya-runner] KRIYA_RUNNER_LIMITS isn't valid")
    process.exit(1)
  }
  if (token.length < 32 || !(generation >= 0)) {
    // Lengths only, never the value
    console.error(
      `[kriya-runner] KRIYA_RUNNER_TOKEN is ${token.length} characters (needs 32+); generation ${Number.isFinite(generation) ? "set" : "missing"}`
    )
    process.exit(1)
  }
  // PORT=0 picks a free port (the local provider reads it from the log line)
  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 10000
  const runner = await createRunner({
    // The image's paths; the local provider (verify stack) sets its own
    root: process.env.KRIYA_RUNNER_ROOT || "/workspace",
    token,
    generation,
    limits: parsedLimits,
    port: port >= 0 ? port : 10000,
    host: process.env.KRIYA_RUNNER_HOST || "0.0.0.0",
    runAs: process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : undefined,
    home: process.env.KRIYA_RUNNER_HOME || "/home/kriya",
    path:
      process.env.KRIYA_RUNNER_PATH ||
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  })
  console.info(
    `[kriya-runner] listening on ${new URL(runner.url).port}, generation ${generation}`
  )
  const stop = () => void runner.close().then(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
