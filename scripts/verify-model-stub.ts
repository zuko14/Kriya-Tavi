// The scripted stub model for UI verification (P-3, UI_VERIFICATION.md §4):
// an OpenAI-compatible chat completions server on 127.0.0.1:6797, so a
// session drives agents with no model cost and the same result every time.
//
//   npm run verify:stub        (OPENROUTER_BASE_URL=http://127.0.0.1:6797/v1)
//
// A marker in the person's latest message, "[verify:<name>]", picks
// tests/operator/verify-scripts/<name>.json: { turns: [{ text } |
// { toolCalls: [{ name, input }] }] }. The turn is the number of assistant
// messages since that message. Without a marker it says a fixed line. It
// reports no cost, so charges come out unpriced, as they would.

import fs from "node:fs"
import http from "node:http"
import path from "node:path"

type Turn = { text?: string; toolCalls?: { name: string; input: unknown }[] }
type Message = { role: string; content?: unknown }

const DEFAULT: Turn = { text: "Stub model: nothing scripted for this message." }
const END: Turn = { text: "That's the end of this verification script." }

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? "").join(" ")
      : ""

export function turnFor(messages: Message[], dir: string): Turn {
  const last = messages.findLastIndex((m) => m.role === "user")
  const marker = /\[verify:([a-z0-9-]{1,40})\]/.exec(textOf(messages[last]?.content))?.[1]
  if (!marker) return DEFAULT
  const file = path.join(dir, `${marker}.json`)
  if (!fs.existsSync(file)) return { text: `No verification script named ${marker}.` }
  const { turns } = JSON.parse(fs.readFileSync(file, "utf8")) as { turns: Turn[] }
  const step = messages.slice(last + 1).filter((m) => m.role === "assistant").length
  return turns[step] ?? END
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

function chunks(turn: Turn, model: string) {
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model }
  const calls = (turn.toolCalls ?? []).map((call, index) => ({
    index,
    id: `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
  }))
  const delta = calls.length
    ? { role: "assistant", tool_calls: calls }
    : { role: "assistant", content: turn.text ?? "" }
  return [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" },
      ],
    },
    { ...base, choices: [], usage: USAGE },
  ]
}

export function startStub(port: number, dir: string) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Only chat completions." } }))
      return
    }
    let raw = ""
    req.on("data", (part) => (raw += part))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as {
        model?: string
        messages?: Message[]
        stream?: boolean
      }
      const turn = turnFor(body.messages ?? [], dir)
      const parts = chunks(turn, body.model ?? "stub")
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const part of parts) res.write(`data: ${JSON.stringify(part)}\n\n`)
        res.end("data: [DONE]\n\n")
        return
      }
      const [first, last] = parts
      const delta = first.choices[0].delta as { content?: string; tool_calls?: unknown[] }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: delta.content ?? null,
                tool_calls: delta.tool_calls,
              },
              finish_reason: last.choices[0].finish_reason,
            },
          ],
          usage: USAGE,
        })
      )
    })
  })
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  )
}

if (process.argv[1]?.endsWith("verify-model-stub.ts")) {
  void startStub(6797, path.join(process.cwd(), "tests/operator/verify-scripts")).then(
    ({ port }) => console.log(`verify:stub listening on http://127.0.0.1:${port}/v1`)
  )
}
