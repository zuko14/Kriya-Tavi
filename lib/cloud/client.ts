import type {
  ChangeSetFile,
  Changes,
  EditRequest,
  ExecEvent,
  ExecRequest,
  ImportResult,
  ListRequest,
  ReadRequest,
  ReadResult,
  SearchRequest,
  WriteRequest,
} from "@/runner/protocol"

// The worker's side of the runner protocol (TOOLS_AND_CONTRACTS §2). The
// token goes only in the Authorization header and never into an error.
// The operation surface also matches AI SDK's Experimental_SandboxSession
// (CD-05, CT-RUN-20), so an AI SDK sandbox adapter could replace it later.

export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

type End = Extract<ExecEvent, { type: "end" }>

const isNotFound = (error: unknown) =>
  error instanceof RunnerRequestError && error.status === 404

export class RunnerClient {
  readonly description =
    "A Linux cloud workspace. The project is in /workspace and every path is relative to it. Commands run in bash as an unprivileged user; the network reaches package registries only."

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 60_000,
    // The provider proxy's own header (Opened.headers), if any
    private readonly proxyHeaders: Record<string, string> = {}
  ) {}

  private async request(
    path: string,
    init: {
      body?: BodyInit
      headers?: Record<string, string>
      signal?: AbortSignal
      timeoutMs?: number
    } = {}
  ) {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs)
    // Joined, not resolved: a runner behind a path (kriya-relay's
    // /v1/forward/<device>, H10) keeps its prefix
    const res = await fetch(new URL(this.baseUrl.replace(/\/+$/, "") + path), {
      method: path === "/v1/health" ? "GET" : "POST",
      headers: {
        ...this.proxyHeaders,
        authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
      body: init.body,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      // A streamed import body
      ...(init.body instanceof ReadableStream && { duplex: "half" }),
    } as RequestInit)
    if (!res.ok) {
      let message = `the workspace runner answered HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: unknown }
        if (typeof body.error === "string") message = body.error
      } catch {}
      throw new RunnerRequestError(res.status, message)
    }
    return res
  }

  private async json<T>(path: string, body: unknown, signal?: AbortSignal) {
    const res = await this.request(path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      signal,
    })
    return (await res.json()) as T
  }

  async health(timeoutMs = 2000) {
    const res = await this.request("/v1/health", { timeoutMs })
    return (await res.json()) as { ok: boolean; version: string; generation: number }
  }

  read(request: ReadRequest) {
    return this.json<ReadResult>("/v1/read", request)
  }

  write(request: WriteRequest) {
    return this.json<{ sha256: string; created: boolean }>("/v1/write", request)
  }

  edit(request: EditRequest) {
    return this.json<{ sha256: string; replacements: number }>("/v1/edit", request)
  }

  patch(patch: string) {
    return this.json<{ files: { path: string; op: string }[] }>("/v1/patch", { patch })
  }

  list(request: ListRequest) {
    return this.json<{
      entries: { path: string; type: "file" | "dir" | "symlink"; bytes: number }[]
      truncated: boolean
    }>("/v1/list", request)
  }

  search(request: SearchRequest) {
    return this.json<{
      matches: { path: string; line: number; text: string }[]
      truncated: boolean
    }>("/v1/search", request)
  }

  changes(maxDiffBytes?: number) {
    return this.json<Changes>("/v1/changes", maxDiffBytes ? { maxDiffBytes } : {})
  }

  files(changeSetId: string) {
    return this.json<{ files: ChangeSetFile[] }>("/v1/files", { changeSetId })
  }

  // NDJSON: output events as they come, then the end event
  async exec(
    request: ExecRequest,
    options: {
      onOutput?: (event: Extract<ExecEvent, { type: "out" }>) => void
      signal?: AbortSignal
    } = {}
  ): Promise<End> {
    const res = await this.request("/v1/exec", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      signal: options.signal,
      // The command's own timeout, plus the kill grace and some slack
      timeoutMs: request.timeoutSeconds * 1000 + 30_000,
    })
    const decoder = new TextDecoder()
    let pending = ""
    let end: End | null = null
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true })
      let newline
      while ((newline = pending.indexOf("\n")) >= 0) {
        const event = JSON.parse(pending.slice(0, newline)) as ExecEvent
        pending = pending.slice(newline + 1)
        if (event.type === "end") end = event
        else options.onOutput?.(event)
      }
    }
    if (!end) throw new RunnerRequestError(502, "the command's result didn't arrive")
    return end
  }

  async import(
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { base: string; strip: boolean }
  ) {
    const res = await this.request("/v1/import", {
      body: body as BodyInit,
      headers: {
        "content-type": "application/x-tar+gzip",
        "x-kriya-strip": options.strip ? "1" : "0",
        "x-kriya-base": options.base,
      },
      timeoutMs: 300_000,
    })
    return (await res.json()) as ImportResult
  }

  async restore(patch: Uint8Array) {
    const res = await this.request("/v1/restore", {
      body: patch as BodyInit,
      headers: { "content-type": "application/octet-stream" },
      timeoutMs: 120_000,
    })
    return (await res.json()) as { applied: true }
  }

  async checkpoint() {
    const res = await this.request("/v1/checkpoint", { timeoutMs: 30_000 })
    return {
      patch: Buffer.from(await res.arrayBuffer()),
      sha256: res.headers.get("x-kriya-sha256") ?? "",
      changes: JSON.parse(res.headers.get("x-kriya-changes") ?? "{}") as {
        files: number
        added: number
        removed: number
      },
    }
  }

  /* ─────────── AI SDK Experimental_SandboxSession surface ─────────── */

  async run(options: {
    command: string
    workingDirectory?: string
    env?: Record<string, string>
    abortSignal?: AbortSignal
  }) {
    const end = await this.exec(
      {
        command: options.command,
        cwd: options.workingDirectory,
        env: options.env,
        // Bounded again by the runner's cloud.commandTimeoutSeconds
        timeoutSeconds: 1800,
      },
      { signal: options.abortSignal }
    )
    // A killed command has no exit code: 124 like timeout(1), else 137
    return {
      exitCode: end.exitCode ?? (end.timedOut ? 124 : 137),
      stdout: end.stdout,
      stderr: end.stderr,
    }
  }

  async readTextFile(options: {
    path: string
    startLine?: number
    endLine?: number
    encoding?: string
    abortSignal?: AbortSignal
  }) {
    try {
      const result = await this.read({
        path: options.path,
        startLine: options.startLine,
        endLine: options.endLine,
      })
      if ("text" in result) return result.text
      const bytes = await this.readBinaryFile(options)
      return bytes && new TextDecoder(options.encoding ?? "utf-8").decode(bytes)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async readBinaryFile(options: { path: string; abortSignal?: AbortSignal }) {
    try {
      const result = await this.read({ path: options.path, encoding: "base64" })
      return "base64" in result
        ? new Uint8Array(Buffer.from(result.base64, "base64"))
        : null
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  // The AI SDK contract overwrites: read first (which satisfies the
  // runner's read-before-write rule), then write
  async writeTextFile(options: {
    path: string
    content: string
    abortSignal?: AbortSignal
  }) {
    await this.read({ path: options.path }).catch((error) => {
      if (!isNotFound(error)) throw error
    })
    await this.write({ path: options.path, content: options.content })
  }

  async writeBinaryFile(options: {
    path: string
    content: Uint8Array
    abortSignal?: AbortSignal
  }) {
    await this.read({ path: options.path }).catch((error) => {
      if (!isNotFound(error)) throw error
    })
    await this.write({
      path: options.path,
      content: Buffer.from(options.content).toString("base64"),
      encoding: "base64",
    })
  }
}
