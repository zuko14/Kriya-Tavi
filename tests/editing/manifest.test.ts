import { generateKeyPairSync, verify } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { GET } from "@/app/api/harness/v1/editing/manifest/route"
import { SETTINGS } from "@/lib/config"
import { CHANNELS, RUNTIMES, servedManifest, signManifest } from "@/lib/editing/manifest"
import {
  DaemonHelloRequest,
  EditingManifestResponse,
  ROUTES,
} from "@/lib/harness/contract"

import { call, deviceFor, harnessDb, harnessEnv } from "../harness/setup"

// ET-API-01 (the manifest route), ET-API-04 and ET-REG-01's server half for ED2.

const ROOT = process.cwd()
const defs = SETTINGS as unknown as Record<
  string,
  { env: string | null; fallback?: string; pattern?: RegExp }
>

let token: string

beforeAll(async () => {
  const db = await harnessDb()
  ;({ token } = await deviceFor(db.pg, await db.createUser()))
})
beforeEach(() =>
  harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_RUNTIME_CHANNEL: undefined })
)

const ask = (options: { token?: string } = { token: undefined }) =>
  GET(call("GET", "/editing/manifest", { token: options.token ?? token }))

describe("ET-REG-01: off means nothing changes", () => {
  it("every editing switch ships off, and the channel defaults to stable", () => {
    expect(defs["editing.studio"].fallback).toBe("off")
    expect(defs["editing.frameVision"].fallback).toBe("off") // ED7, EDD-14
    expect(defs["editing.customMotion"].fallback).toBe("off") // ED8, EDD-44
    expect(defs["editing.runtimeChannel"].fallback).toBe("stable")
    expect(defs["editing.runtimeChannel"].pattern?.test("nightly")).toBe(false)
    const keys = Object.keys(defs).filter((key) => key.startsWith("editing."))
    for (const key of keys) {
      if (defs[key].pattern?.source === "^(on|off)$")
        expect(defs[key].fallback, key).toBe("off")
    }
  })

  it("with editing.studio off the route says nothing, signed in or not", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined })
    const res = await ask()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found", message: "Not found." })
  })

  it("with harness.api off it says nothing either", async () => {
    harnessEnv({ KRIYA_HARNESS_API: undefined })
    expect((await ask()).status).toBe(404)
  })

  it("an old client's hello is still valid: edit is optional, and nothing else moved", () => {
    const hello = {
      daemonVersion: "0.2.0",
      capabilities: { fullAccess: false, serve: false, handoff: true },
      projects: [],
      rules: [],
    }
    expect(DaemonHelloRequest.safeParse(hello).success).toBe(true)
    const withEdit = { ...hello, capabilities: { ...hello.capabilities, edit: true } }
    expect(DaemonHelloRequest.safeParse(withEdit).success).toBe(true)
    const extra = { ...hello, capabilities: { ...hello.capabilities, render: true } }
    expect(DaemonHelloRequest.safeParse(extra).success).toBe(false)
  })
})

describe("ET-API-01: the route", () => {
  it("is in the contract, signed in only, and answers its schema", async () => {
    const route = ROUTES.find((r) => r.path === "/editing/manifest")
    expect(route).toMatchObject({ method: "GET", auth: true })
    const res = await ask()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(EditingManifestResponse.safeParse(body).success).toBe(true)
    expect(JSON.parse(body.manifest).version).toBe(CHANNELS.stable)
  })

  it("needs a device", async () => {
    const res = await GET(call("GET", "/editing/manifest"))
    expect(res.status).toBe(401)
  })

  it("editing.runtimeChannel picks what's served", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_RUNTIME_CHANNEL: "beta" })
    const body = await (await ask()).json()
    expect(JSON.parse(body.manifest).version).toBe(CHANNELS.beta)
  })
})

describe("ET-API-04: only approved, pinned versions", () => {
  const manifests = Object.values(RUNTIMES).map((runtime) => runtime.manifest)

  it("each channel names a version that exists", () => {
    for (const version of Object.values(CHANNELS)) expect(RUNTIMES[version]).toBeDefined()
    expect(() => servedManifest("nightly")).toThrow()
  })

  it("every artifact is exact: https, a real sha256, a size, a licence, nothing moving", () => {
    for (const manifest of manifests) {
      for (const platform of Object.values(manifest.platforms)) {
        for (const artifact of platform.artifacts) {
          expect(artifact.url).toMatch(/^https:\/\//)
          expect(artifact.url).toContain(artifact.version)
          expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
          expect(artifact.bytes).toBeGreaterThan(0)
          expect(artifact.licence.length).toBeGreaterThan(2)
        }
      }
    }
  })

  it("the Python environment is fully hash-locked, and every package has a licence", () => {
    for (const manifest of manifests) {
      for (const { python } of Object.values(manifest.platforms)) {
        const pins = python.requirements
          .split("\n")
          .filter((line) => /^[a-z0-9]/i.test(line))
        expect(pins.length).toBe(python.packages.length)
        for (const pin of pins) expect(pin).toMatch(/^[a-zA-Z0-9._-]+==\S+ \\$/)
        expect(python.requirements).toContain("--hash=sha256:")
        expect(python.requirements).not.toMatch(/>=|~=|git\+|https?:/)
        for (const item of python.packages) expect(item.licence.length).toBeGreaterThan(1)
      }
    }
  })

  it("EDD-48: mlx-whisper on Apple silicon; EDD-06: FFmpeg is the person's, not ours", () => {
    for (const manifest of manifests) {
      const mac = manifest.platforms["darwin-arm64"]
      expect(mac.python.packages.map((item) => item.name)).toContain("mlx-whisper")
      expect(mac.system.find((tool) => tool.id === "ffmpeg")?.fix).toBe(
        "brew install ffmpeg"
      )
      expect(JSON.stringify(mac.artifacts)).not.toMatch(/ffmpeg/i)
    }
  })

  it("a signature made offline verifies over exactly the bytes served", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const { manifest } = servedManifest("stable")
    const signature = signManifest(manifest, pem)
    expect(EditingManifestResponse.safeParse({ manifest, signature }).success).toBe(true)
    expect(
      verify(null, Buffer.from(manifest), publicKey, Buffer.from(signature, "base64"))
    ).toBe(true)
    expect(
      verify(
        null,
        Buffer.from(`${manifest} `),
        publicKey,
        Buffer.from(signature, "base64")
      )
    ).toBe(false)
  })

  it("no private key sits in the repository's editing code", () => {
    const dir = path.join(ROOT, "lib/editing")
    const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    for (const file of files) {
      const full = path.join(dir, file)
      if (fs.statSync(full).isFile())
        expect(fs.readFileSync(full, "utf8")).not.toContain("PRIVATE KEY-----\n")
    }
  })
})
