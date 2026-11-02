import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

// RT-IMP-01 (CHANGE_IMPACT §4): lib/rooms, the room actions and queries
// never import connectors or metering; room client components import no
// server module (lib/rooms, db, lib/config), and queries only as types.

const FILES = [
  ...fs
    .readdirSync("lib/rooms", { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join("lib/rooms", file)),
  "actions/rooms.ts",
  "queries/rooms.ts",
]

describe("RT-IMP-01: room imports", () => {
  it("covers the room modules", () => {
    expect(FILES).toContain("lib/rooms/core.ts")
  })

  it.each(FILES)("%s imports no connector or metering code", (file) => {
    const source = fs.readFileSync(file, "utf8")
    expect(source).not.toMatch(/["']@\/lib\/connectors/)
    expect(source).not.toMatch(/["']@\/lib\/agent\/metering["']/)
    expect(source).not.toMatch(/["']@\/lib\/secrets["']/)
  })

  // R4: runTask loads these in kriya-worker, which runs under plain Node,
  // where the server-only marker throws on import
  const WORKER = [
    "lib/rooms/agents.ts",
    "lib/rooms/conductor.ts",
    "lib/rooms/context.ts",
    "lib/rooms/invoke.ts",
    "lib/rooms/names.ts",
    "lib/rooms/notes.ts",
    "lib/rooms/proof.ts",
    "lib/rooms/realtime.ts",
    "lib/rooms/recheck.ts",
    "lib/rooms/relay.ts",
    "lib/rooms/tools.ts",
  ]
  it.each(WORKER)("%s, loaded by the worker, has no server-only marker", (file) => {
    const source = fs.readFileSync(file, "utf8")
    expect(source).not.toMatch(/["']server-only["']/)
    for (const line of source.match(/^import .* from ["']@\/lib\/rooms\/[a-z-]+["']/gm) ??
      [])
      expect(WORKER.map((w) => `@/${w.replace(/\.ts$/, "")}`)).toContain(
        line.match(/["'](@\/lib\/rooms\/[a-z-]+)["']/)![1]
      )
  })

  const CLIENT = fs
    .readdirSync("components/rooms", { encoding: "utf8" })
    .map((file) => path.join("components/rooms", file))
    .filter((file) => fs.readFileSync(file, "utf8").startsWith('"use client"'))

  it("covers the room client components", () => {
    expect(CLIENT).toContain("components/rooms/room-view.tsx")
  })

  it.each(CLIENT)("%s imports no server module", (file) => {
    const source = fs.readFileSync(file, "utf8")
    expect(source).not.toMatch(/from ["']@\/(lib\/rooms|db|lib\/config|lib\/models)/)
    for (const line of source.match(/^import .* from ["']@\/queries\/.*$/gm) ?? [])
      expect(line, file).toMatch(/^import type /)
  })
})
