import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createRunner } from "@/runner/index"

// The device side of the relay (HD-12) for tests: what `kriya serve` does in
// the kriya-harness repository, in TypeScript over the real runner. One
// runner per open workspace, in <folder>/<workspace id>-<generation>.

const REF = /^device-([0-9a-f-]{36})-([0-9a-f-]{36})-(\d{1,9})$/

type Frame =
  | {
      t: "req"
      id: number
      method: string
      path: string
      headers: Record<string, string>
    }
  | { t: "body"; id: number; data: string }
  | { t: "end"; id: number }
  | { t: "abort"; id: number }

export async function serveDevice(options: {
  relayUrl: string
  deviceId: string
  token: string
  folder: string
}) {
  const runners = new Map<string, Awaited<ReturnType<typeof createRunner>>>()
  const pending = new Map<
    number,
    { method: string; path: string; headers: Record<string, string>; chunks: Buffer[] }
  >()
  const aborts = new Map<number, AbortController>()
  const url = `${options.relayUrl.replace(/^http/, "ws")}/v1/device/${options.deviceId}`
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${options.token}`, "x-kriya-harness": "0.1.0" },
  } as unknown as string[])
  const send = (frame: unknown) => socket.send(JSON.stringify(frame))

  const dirOf = (ref: string) => {
    const match = REF.exec(ref)
    if (!match || match[1] !== options.deviceId) return null
    return path.join(options.folder, `${match[2]}-${match[3]}`)
  }

  async function world(route: string, body: Record<string, unknown>) {
    if (route === "/world/list") {
      const names = await fs.readdir(options.folder).catch(() => [] as string[])
      return {
        status: 200,
        body: {
          refs: names
            .map((name) => /^([0-9a-f-]{36})-(\d{1,9})$/.exec(name))
            .filter((m) => m !== null)
            .map((m) => {
              const ref = `device-${options.deviceId}-${m[1]}-${m[2]}`
              return { ref, running: runners.has(ref) }
            }),
        },
      }
    }
    const ref = String(body.ref ?? "")
    const dir = dirOf(ref)
    if (!dir) return { status: 400, body: { error: "not a workspace of this machine" } }
    if (route === "/world/open") {
      const exists = await fs.stat(dir).then(
        () => true,
        () => false
      )
      if (body.fresh) await fs.mkdir(dir, { recursive: true })
      else if (!exists) return { status: 404, body: { error: "gone" } }
      await runners.get(ref)?.close()
      runners.set(
        ref,
        await createRunner({
          root: dir,
          token: String(body.token),
          generation: Number(body.generation),
          limits: body.limits,
          home: os.tmpdir(),
          path: process.env.PATH ?? "/usr/bin:/bin",
        })
      )
      return { status: 200, body: { opened: true } }
    }
    if (route === "/world/pause" || route === "/world/destroy") {
      await runners.get(ref)?.close()
      runners.delete(ref)
      if (route === "/world/destroy") await fs.rm(dir, { recursive: true, force: true })
      return { status: 200, body: { ok: true } }
    }
    return { status: 404, body: { error: "not found" } }
  }

  async function handle(id: number) {
    const req = pending.get(id)!
    pending.delete(id)
    const body = Buffer.concat(req.chunks)
    try {
      if (req.path.startsWith("/world/")) {
        const answer = await world(req.path, body.length ? JSON.parse(String(body)) : {})
        send({
          t: "res",
          id,
          status: answer.status,
          headers: { "content-type": "application/json" },
        })
        send({
          t: "body",
          id,
          data: Buffer.from(JSON.stringify(answer.body)).toString("base64"),
        })
        return send({ t: "end", id })
      }
      const runner = runners.get(req.headers["x-kriya-world-ref"] ?? "")
      if (!runner) {
        send({
          t: "res",
          id,
          status: 503,
          headers: { "content-type": "application/json" },
        })
        send({
          t: "body",
          id,
          data: Buffer.from(JSON.stringify({ error: "no workspace open" })).toString(
            "base64"
          ),
        })
        return send({ t: "end", id })
      }
      const abort = new AbortController()
      aborts.set(id, abort)
      const res = await fetch(runner.url + req.path, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : body,
        signal: abort.signal,
      })
      send({
        t: "res",
        id,
        status: res.status,
        headers: Object.fromEntries(res.headers),
      })
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        send({ t: "body", id, data: Buffer.from(chunk).toString("base64") })
      }
      send({ t: "end", id })
    } catch (error) {
      send({ t: "error", id, message: (error as Error).message })
    } finally {
      aborts.delete(id)
    }
  }

  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame
    if (frame.t === "req") {
      pending.set(frame.id, { ...frame, chunks: [] })
    } else if (frame.t === "body") {
      pending.get(frame.id)?.chunks.push(Buffer.from(frame.data, "base64"))
    } else if (frame.t === "end") {
      void handle(frame.id)
    } else if (frame.t === "abort") {
      aborts.get(frame.id)?.abort()
    }
  })

  const opened = await new Promise<boolean>((done) => {
    socket.addEventListener("open", () => done(true))
    socket.addEventListener("error", () => done(false))
    socket.addEventListener("close", () => done(false))
  })
  return {
    opened,
    socket,
    close: async () => {
      socket.close()
      for (const runner of runners.values()) await runner.close()
      runners.clear()
    },
  }
}
