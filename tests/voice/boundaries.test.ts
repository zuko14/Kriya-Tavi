import fs from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { checkEnvironment } from "@/lib/env"

const ROOT = process.cwd()

// Every module a service loads at run time, following "@/…" and relative
// imports (packages are recorded, not entered)
function importGraph(entry: string) {
  const files = new Set<string>()
  const packages = new Set<string>()
  const pattern =
    /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
  const resolve = (from: string, spec: string) => {
    const base = spec.startsWith("@/")
      ? path.join(ROOT, spec.slice(2))
      : path.resolve(path.dirname(from), spec)
    return ["", ".ts", ".tsx", "/index.ts", ".json"]
      .map((ext) => base + ext)
      .find((file) => fs.existsSync(file) && fs.statSync(file).isFile())
  }
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    if (file.endsWith(".json")) return
    for (const match of fs.readFileSync(file, "utf8").matchAll(pattern)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        const target = resolve(file, spec)
        if (target) visit(target)
      } else packages.add(spec)
    }
  }
  visit(path.join(ROOT, entry))
  return {
    files: [...files].map((f) => path.relative(ROOT, f).replaceAll("\\", "/")),
    packages: [...packages],
  }
}

const NEXT_ONLY_FILES = [
  "lib/auth.ts",
  "lib/supabase.ts",
  "lib/rate-limit.ts",
  "lib/owner.ts",
]

describe("T-IMP-01 services load no Next.js-only module (F7)", () => {
  it.each(["voice/index.ts", "worker/index.ts"])("%s", (entry) => {
    const { files, packages } = importGraph(entry)
    expect(files.length).toBeGreaterThan(entry.startsWith("voice") ? 5 : 20)
    expect(files.filter((f) => NEXT_ONLY_FILES.includes(f))).toEqual([])
    expect(
      packages.filter((p) => p === "server-only" || p === "next" || p.startsWith("next/"))
    ).toEqual([])
  })

  it("the voice service loads the voice modules it needs and nothing of the agent", () => {
    const { files } = importGraph("voice/index.ts")
    expect(files).toEqual(
      expect.arrayContaining([
        "lib/voice/audio.ts",
        "lib/voice/providers.ts",
        "lib/voice/streams.ts",
      ])
    )
    expect(files.filter((f) => f.startsWith("lib/agent/"))).toEqual([])
  })

  // Voice phase 4: what kriya-voice runs per call. Of the agent it may load
  // only the in-call tools (owner decision 2026-10-20), never the agent tool
  // belt with its connectors and token code
  it("the call session loads the in-call tools and nothing else of the agent", () => {
    const { files, packages } = importGraph("lib/voice/session.ts")
    expect(files.filter((f) => NEXT_ONLY_FILES.includes(f))).toEqual([])
    expect(
      packages.filter((p) => p === "server-only" || p === "next" || p.startsWith("next/"))
    ).toEqual([])
    expect(files.filter((f) => f.startsWith("lib/agent/"))).toEqual([
      "lib/agent/call-tools.ts",
    ])
    expect(
      files.filter((f) => /^lib\/(secrets|connectors|browser|memory)/.test(f))
    ).toEqual([])
  })
})

// lib/voice can't use "server-only" (it would crash kriya-voice, F7), so
// client components are checked here instead: none may import it
it("no client component imports lib/voice", () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(entry.name)) {
        const source = fs.readFileSync(path.join(ROOT, rel), "utf8")
        if (/^["']use client["']/m.test(source) && /lib\/voice/.test(source)) {
          offenders.push(rel)
        }
      }
    }
  }
  for (const dir of ["app", "components"]) walk(dir)
  expect(offenders).toEqual([])
})

// Owner reminders are phone calls only (VOICE_REMINDERS §1, voice rule 10):
// no voice module reaches the in-app notifier, /api/events, a connector
// that sends mail or messages, or an SMS/email/push package
it("T-REM-07 voice code imports no notification channel", () => {
  const sources = fs
    .readdirSync(path.join(ROOT, "lib/voice"), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `lib/voice/${f.replaceAll("\\", "/")}`)
  expect(sources.length).toBeGreaterThan(10)
  for (const file of sources) {
    const { files, packages } = importGraph(file)
    expect(
      files.filter((f) =>
        /^(lib\/events\.ts|lib\/connectors|components\/workspace\/notifier|app\/api\/events\/)/.test(
          f
        )
      ),
      file
    ).toEqual([])
    expect(
      packages.filter((p) => /mail|sms|push|twilio|whatsapp|firebase|resend/i.test(p)),
      file
    ).toEqual([])
    expect(fs.readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(
      /\bnew Notification\b|showNotification|navigator\.vibrate/
    )
  }
})

describe("T-ENV-01 environment checks", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const production = (values: Record<string, string>) => {
    vi.stubEnv("NODE_ENV", "production")
    for (const name of [
      "DATABASE_URL",
      "OPENROUTER_API_KEY",
      "KRIYA_VOICE_STREAM_SECRET",
    ]) {
      vi.stubEnv(name, values[name] ?? "")
    }
  }

  it("the worker starts with no voice variables", () => {
    production({
      DATABASE_URL: "postgres://user@db.example.com:6543/postgres",
      OPENROUTER_API_KEY: "test-key",
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(() => checkEnvironment("worker")).not.toThrow()
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/EXOTEL|VOICE/)
    warn.mockRestore()
  })

  it("kriya-voice needs its database and stream secret, named but not shown", () => {
    production({ DATABASE_URL: "postgres://user@db.example.com:6543/postgres" })
    expect(() => checkEnvironment("voice")).toThrow(
      /KRIYA_VOICE_STREAM_SECRET is missing/
    )
    production({
      DATABASE_URL: "postgres://user@db.example.com:6543/postgres",
      KRIYA_VOICE_STREAM_SECRET: "too-short-secret",
    })
    expect(() => checkEnvironment("voice")).toThrow(/at least 32 characters/)
    expect(() => checkEnvironment("voice")).not.toThrow(/too-short-secret/)
    production({
      DATABASE_URL: "postgres://user@db.example.com:6543/postgres",
      KRIYA_VOICE_STREAM_SECRET: "s".repeat(32),
    })
    expect(() => checkEnvironment("voice")).not.toThrow()
  })
})
