import fs from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"

import { describe, expect, it } from "vitest"

// Module boundaries of track C (TEST_STRATEGY CT-IMP-*).

const ROOT = process.cwd()

function imports(file: string) {
  const source = fs.readFileSync(file, "utf8")
  return [...source.matchAll(/^\s*(?:import|export)\s[^"']*?from\s+["']([^"']+)["']/gm)]
    .map((m) => ({ spec: m[1], statement: m[0] }))
    .concat(
      [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => ({
        spec: m[1],
        statement: m[0],
      }))
    )
}

describe("CT-IMP-02: the runner imports nothing of Kriya", () => {
  it("only Node built-ins, zod, its own files and the two egress predicates", () => {
    const dir = path.join(ROOT, "runner")
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(5)
    const builtins = new Set(builtinModules)
    const bad: string[] = []
    for (const file of files) {
      for (const { spec, statement } of imports(path.join(dir, file))) {
        if (spec.startsWith("node:") || builtins.has(spec) || spec === "zod") continue
        if (spec.startsWith("./") && !spec.includes("..")) continue
        if (
          spec === "../browser/egress" &&
          /\{\s*(isBlockedAddress|isBlockedHost)(\s*,\s*(isBlockedAddress|isBlockedHost))?\s*\}/.test(
            statement
          )
        )
          continue
        bad.push(`${file}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe("CT-IMP-01: lib/cloud stays worker code with narrow seams", () => {
  it("no next/*; only the named connector and file-store imports; runner types only", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) walk(full)
        else if (item.name.endsWith(".ts")) files.push(full)
      }
    }
    walk(path.join(ROOT, "lib", "cloud"))
    expect(files.length).toBeGreaterThan(5)
    const bad: string[] = []
    for (const file of files) {
      const rel = path.relative(ROOT, file)
      for (const { spec, statement } of imports(file)) {
        if (spec === "next" || spec.startsWith("next/")) bad.push(`${rel}: ${spec}`)
        if (spec.startsWith("@/lib/connectors")) {
          const names =
            statement
              .match(/\{([^}]*)\}/)?.[1]
              .split(",")
              .map((n) => n.trim()) ?? []
          const allowed = ["githubTarball", "githubCommitTree", "githubOpenDraftPr"]
          if (
            spec !== "@/lib/connectors/github" ||
            names.some((n) => !allowed.includes(n))
          )
            bad.push(`${rel}: ${statement}`)
        }
        if (spec === "@/lib/files") {
          const names =
            statement
              .match(/\{([^}]*)\}/)?.[1]
              .split(",")
              .map((n) => n.trim()) ?? []
          // BUCKET: the janitor's storage sweep names the bucket (C6)
          const allowed = ["fileStore", "type FileStore", "BUCKET"]
          if (names.some((n) => !allowed.includes(n))) bad.push(`${rel}: ${statement}`)
        }
        if (spec.startsWith("@/runner") && !/^\s*import\s+type\s/.test(statement))
          bad.push(`${rel}: ${statement} (types only)`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe("CT-IMP-03: only worker code imports lib/cloud", () => {
  it("never app/, actions/, components/ or queries/ (paths.ts aside); outside lib/cloud only lib/agent and the worker", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", ".git", ".claude", "tests"].includes(item.name))
          continue
        const full = path.join(dir, item.name)
        if (item.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(item.name)) files.push(full)
      }
    }
    walk(ROOT)
    const bad: string[] = []
    for (const file of files) {
      const rel = path.relative(ROOT, file)
      if (rel.startsWith("lib/cloud/")) continue
      for (const { spec } of imports(file)) {
        if (!spec.startsWith("@/lib/cloud")) continue
        if (spec === "@/lib/cloud/paths") continue
        if (rel.startsWith("lib/agent/") || rel === "worker/index.ts") continue
        bad.push(`${rel}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })
})
