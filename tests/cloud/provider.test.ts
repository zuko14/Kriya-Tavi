import fs from "node:fs"
import { randomUUID } from "node:crypto"

import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { RunnerClient } from "@/lib/cloud/client"
import { LocalWorkspaceProvider } from "@/lib/cloud/providers/local"
import { setWorkspaceProviderForTests, workspaceProvider } from "@/lib/cloud/session"
import { runnerToken } from "@/lib/cloud/token"

import { createTestDb } from "../db/harness"
import { FakeProvider, textOf } from "./fake-provider"

// CT-PRV-01 (CD-07): the `local` provider runs only on the verify stack, and
// no provider is constructed without a complete configuration.

const NAMES = [
  "KRIYA_CLOUD_PROVIDER",
  "KRIYA_WORKSPACE_LOCAL",
  "KRIYA_WORKSPACE_SECRET",
  "DATABASE_URL",
  "KRIYA_APP_URL",
  "E2B_API_KEY",
  "DAYTONA_API_KEY",
  "KRIYA_RELAY_URL",
  "KRIYA_RELAY_SECRET",
  "KRIYA_HARNESS_DEVICE_WORLD",
]
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))

const configure = (env: Record<string, string | undefined>) => {
  for (const name of NAMES) {
    if (env[name] === undefined) delete process.env[name]
    else process.env[name] = env[name]
  }
  ;(globalThis as { __kriyaSettings?: unknown }).__kriyaSettings = undefined
}

const LOCAL = {
  KRIYA_CLOUD_PROVIDER: "local",
  KRIYA_WORKSPACE_LOCAL: "1",
  KRIYA_WORKSPACE_SECRET: "s".repeat(43),
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
}

beforeAll(async () => {
  const pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
})

afterEach(() => {
  setWorkspaceProviderForTests(null)
  configure(saved)
})

describe("CT-PRV-01: which provider, if any", () => {
  it("none by default, and none while the configuration is incomplete", async () => {
    configure({ ...LOCAL, KRIYA_CLOUD_PROVIDER: undefined })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...LOCAL, KRIYA_WORKSPACE_LOCAL: undefined })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...LOCAL, DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres" })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...LOCAL, DATABASE_URL: undefined })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...LOCAL, KRIYA_WORKSPACE_SECRET: undefined })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...LOCAL, KRIYA_WORKSPACE_SECRET: "short" })
    expect(await workspaceProvider()).toBeNull()
    // A vendor without its key, or without this deployment's host to tag with
    configure({
      ...LOCAL,
      KRIYA_CLOUD_PROVIDER: "e2b",
      KRIYA_APP_URL: "https://kriya.example",
    })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...LOCAL, KRIYA_CLOUD_PROVIDER: "daytona", DAYTONA_API_KEY: "k" })
    expect(await workspaceProvider()).toBeNull()
  })

  it("a vendor adapter with its key, the runner secret and the app's host (C8)", async () => {
    const vendor = {
      KRIYA_WORKSPACE_SECRET: "s".repeat(43),
      KRIYA_APP_URL: "https://kriya.example",
    }
    configure({ ...vendor, KRIYA_CLOUD_PROVIDER: "e2b", E2B_API_KEY: "k" })
    expect((await workspaceProvider())?.name).toBe("e2b")
    configure({ ...vendor, KRIYA_CLOUD_PROVIDER: "daytona", DAYTONA_API_KEY: "k" })
    expect((await workspaceProvider())?.name).toBe("daytona")
    configure({ ...vendor, KRIYA_CLOUD_PROVIDER: "daytona", E2B_API_KEY: "k" })
    expect(await workspaceProvider()).toBeNull()
  })

  it("device (H10, HD-12): the relay's address and secret and harness.deviceWorld on", async () => {
    const device = {
      KRIYA_CLOUD_PROVIDER: "device",
      KRIYA_WORKSPACE_SECRET: "s".repeat(43),
      KRIYA_RELAY_URL: "https://relay.kriya.example",
      KRIYA_RELAY_SECRET: "r".repeat(43),
      KRIYA_HARNESS_DEVICE_WORLD: "on",
    }
    configure(device)
    expect((await workspaceProvider())?.name).toBe("device")
    configure({ ...device, KRIYA_HARNESS_DEVICE_WORLD: undefined })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...device, KRIYA_RELAY_URL: undefined })
    expect(await workspaceProvider()).toBeNull()
    configure({ ...device, KRIYA_RELAY_SECRET: "short" })
    expect(await workspaceProvider()).toBeNull()
  })

  it("local on the verify stack; a test override wins", async () => {
    configure(LOCAL)
    expect((await workspaceProvider())?.name).toBe("local")
    configure({
      ...LOCAL,
      DATABASE_URL: "postgresql://postgres@localhost:54322/postgres",
    })
    expect((await workspaceProvider())?.name).toBe("local")
    const fake = new FakeProvider()
    setWorkspaceProviderForTests(fake)
    configure({})
    expect(await workspaceProvider()).toBe(fake)
  })

  it("the local adapter itself refuses off the verify stack", async () => {
    configure({ ...LOCAL, DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres" })
    await expect(
      new LocalWorkspaceProvider().create({
        workspaceId: randomUUID(),
        userId: randomUUID(),
        generation: 1,
        image: "local",
        size: "2c-4g",
        network: "registries",
        runnerToken: "t".repeat(43),
        limits: {},
        timeoutSeconds: 600,
      })
    ).rejects.toThrow(/verify stack/)
  })

  it("local: create, pause, resume and destroy a runner child process", async () => {
    configure(LOCAL)
    const provider = new LocalWorkspaceProvider()
    const workspaceId = randomUUID()
    const token = runnerToken(workspaceId, 1)
    const spec = {
      workspaceId,
      userId: randomUUID(),
      generation: 1,
      image: "local",
      size: "2c-4g",
      network: "registries" as const,
      runnerToken: token,
      limits: {},
      timeoutSeconds: 600,
    }
    const opened = await provider.create(spec)
    try {
      const client = new RunnerClient(opened.runnerUrl, token)
      expect(await client.health()).toMatchObject({ ok: true, generation: 1 })
      // The runner process gets no worker environment
      const env = await client.run({ command: "env" })
      expect(env.stdout).not.toContain("KRIYA_WORKSPACE_SECRET")
      expect(env.stdout).not.toContain("DATABASE_URL")
      await client.write({ path: "kept.txt", content: "kept\n" })
      expect((await provider.list()).map((s) => s.workspaceId)).toContain(workspaceId)

      await provider.pause(opened.ref)
      await expect(client.health()).rejects.toThrow()
      const resumed = await provider.resume(opened.ref, spec)
      expect(resumed).not.toBeNull()
      const again = new RunnerClient(resumed!.runnerUrl, token)
      expect(await textOf(again, "kept.txt")).toBe("kept\n")
    } finally {
      await provider.destroy(opened.ref)
    }
    await provider.destroy(opened.ref)
    expect(await provider.resume(opened.ref, spec)).toBeNull()
    expect(fs.existsSync(provider.rootOf(opened.ref))).toBe(false)
  }, 60_000)
})
