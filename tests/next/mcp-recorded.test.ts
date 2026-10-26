import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { FIXTURE_TOOLS } from "../fixtures/mcp/server"
import { pinnedSchema } from "@/lib/mcp/tools"
import { readBack, verifySpecSchema } from "@/lib/mcp/verify"

// NR-5 / NT-MCP-20: every file in tests/fixtures/mcp/recorded/ is a capture of
// a server's answers, one entry per tool: { request, response }. This replays
// them through the runtime's own readers, so a real server's capture has to fit
// the same shapes before it can be listed in lib/mcp/recorded.ts. The only file
// today is the repo's own fixture app, not a provider; it is not listed there.

const dir = path.join(process.cwd(), "tests/fixtures/mcp/recorded")
type Entry = {
  request: { name: string; arguments: Record<string, unknown> }
  response: { content?: unknown; structuredContent?: Record<string, unknown> }
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))

describe("recorded responses", () => {
  it("has a capture to replay", () => expect(files.length).toBeGreaterThan(0))

  for (const file of files) {
    const recorded = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<
      string,
      Entry
    >
    describe(file, () => {
      it("says where it came from", () => {
        expect(recorded._meta).toMatchObject({ source: expect.any(String) })
      })

      it("each request fits the tool's pinned input schema; each answer has content", () => {
        for (const [tool, entry] of Object.entries(recorded).filter(
          ([k]) => k !== "_meta"
        )) {
          expect(entry.request.name, tool).toBe(tool)
          const def = FIXTURE_TOOLS.find((t) => t.name === tool)!
          expect(
            pinnedSchema(def.inputSchema).safeParse(entry.request.arguments).success,
            tool
          ).toBe(true)
          expect(entry.response.content, tool).toBeInstanceOf(Array)
        }
      })

      it("the recorded create and get replay through the read-back mapping as verified", async () => {
        if (!recorded.create_item || !recorded.get_item) return
        const spec = verifySpecSchema.parse({
          tool: "get_item",
          args: { id: "/structuredContent/id" },
          expect: { "/structuredContent/title": "/input/title" },
        })
        const out = await readBack(
          spec,
          {
            input: recorded.create_item.request.arguments,
            structuredContent: recorded.create_item.response.structuredContent,
          },
          async () => recorded.get_item.response
        )
        expect(out.status).toBe("verified")
      })
    })
  }
})
