import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Experimental_SandboxSession } from "ai"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { RunnerClient, RunnerRequestError } from "@/lib/cloud/client"
import { createRunner } from "@/runner"

// The worker's runner client (lib/cloud/client.ts) against the real runner.
// CT-RUN-20 (CD-05, moved to C3 by the owner, CF-14): the operation surface
// is structurally an AI SDK sandbox session, checked by the compiler.

const TOKEN = "c".repeat(43)
let runner: Awaited<ReturnType<typeof createRunner>>
let root: string

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kriya-client-")))
  runner = await createRunner({
    root,
    token: TOKEN,
    generation: 4,
    home: fs.mkdtempSync(path.join(os.tmpdir(), "kriya-client-home-")),
    path: process.env.PATH ?? "/usr/bin:/bin",
    killGraceMs: 200,
  })
})

afterAll(() => runner.close())

describe("runner client", () => {
  it("CT-RUN-20: satisfies the Experimental_SandboxSession subset", async () => {
    const client = new RunnerClient(runner.url, TOKEN) satisfies Pick<
      Experimental_SandboxSession,
      | "run"
      | "readTextFile"
      | "writeTextFile"
      | "readBinaryFile"
      | "writeBinaryFile"
      | "description"
    >
    expect(client.description).toMatch(/\/workspace/)

    const ran = await client.run({
      command: "echo $GREETING; echo err >&2; exit 2",
      env: { GREETING: "hi" },
    })
    expect(ran).toEqual({ exitCode: 2, stdout: "hi\n", stderr: "err\n" })
    fs.mkdirSync(path.join(root, "sub"), { recursive: true })
    expect((await client.run({ command: "pwd", workingDirectory: "sub" })).stdout).toBe(
      `${root}/sub\n`
    )

    expect(await client.readTextFile({ path: "missing.txt" })).toBeNull()
    await client.writeTextFile({ path: "deep/a.txt", content: "one\ntwo\nthree\n" })
    // Overwrites like the AI SDK contract says
    await client.writeTextFile({ path: "deep/a.txt", content: "1\n2\n3\n" })
    expect(
      await client.readTextFile({ path: "deep/a.txt", startLine: 2, endLine: 9 })
    ).toBe("2\n3\n")

    const bytes = new Uint8Array([0, 1, 2, 255])
    await client.writeBinaryFile({ path: "b.bin", content: bytes })
    expect(await client.readBinaryFile({ path: "b.bin" })).toEqual(bytes)
    expect(await client.readBinaryFile({ path: "nope.bin" })).toBeNull()
  })

  it("streams exec output and reports runner refusals with their status", async () => {
    const client = new RunnerClient(runner.url, TOKEN)
    const seen: string[] = []
    const end = await client.exec(
      { command: "echo a; echo b", timeoutSeconds: 10 },
      { onOutput: (event) => seen.push(event.text) }
    )
    expect(seen.join("")).toBe("a\nb\n")
    expect(end).toMatchObject({ exitCode: 0, stdout: "a\nb\n" })
    expect(await client.health()).toEqual({
      ok: true,
      version: expect.any(String),
      generation: 4,
    })

    const error = await client.read({ path: "../x" }).catch((e) => e)
    expect(error).toBeInstanceOf(RunnerRequestError)
    expect(error.status).toBe(403)
    expect(error.message).not.toContain(TOKEN)
    const wrong = await new RunnerClient(runner.url, "w".repeat(43))
      .list({})
      .catch((e) => e)
    expect(wrong.status).toBe(401)
  })
})
