import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// AT-IMP-01: kriya-browser has no database access and no secrets but its
// own, so browser/ imports only Node built-ins, playwright-core, ws and its
// own files. A static scan; runs on every `npm test`.

const ROOT = path.join(process.cwd(), "browser")
const ALLOWED = (spec: string) =>
  spec.startsWith("node:") ||
  spec === "playwright-core" ||
  spec === "ws" ||
  spec.startsWith("./")
const ENV = [
  "KRIYA_BROWSER_SECRET",
  "PORT",
  "BROWSER_MAX_SESSIONS",
  "BROWSER_SESSION_MAX_SECONDS",
  "BROWSER_CHROMIUM_PATH",
]

describe("AT-IMP-01 browser/ import boundary", () => {
  const files = fs
    .readdirSync(ROOT, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|js|mjs)$/.test(file))

  it("has files to check", () => {
    expect(files).toEqual(expect.arrayContaining(["index.ts", "session.ts", "egress.ts"]))
  })

  it.each(files)("%s imports only what the boundary allows", (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8")
    const specs = [
      ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ].map((match) => match[1])
    expect(specs.filter((spec) => !ALLOWED(spec))).toEqual([])
  })

  it("reads no database, model or connector settings from the environment", () => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8")
      for (const [, name] of source.matchAll(/process\.env\.([A-Z_]+)/g)) {
        expect(ENV, `${file}: ${name}`).toContain(name)
      }
      expect(source, file).not.toMatch(/process\.env\[/)
    }
  })
})
