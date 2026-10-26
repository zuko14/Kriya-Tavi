import fs from "node:fs"
import path from "node:path"

import type { ModelMessage } from "ai"
import { describe, expect, it } from "vitest"

import { actionTitle } from "@/lib/agent/approvals"
import { GRANTABLE, UNCLASSIFIED_OK, unclassifiedTools } from "@/lib/agent/capabilities"
import { deriveEpisode } from "@/lib/agent/episodes"
import {
  classifyMcpTool,
  PERSON_ONLY_WRITES,
  TOOL_CLASSES,
  TOOL_WRITES,
  type McpPolicyInput,
} from "@/lib/agent/policy"
import { TOOL_APPROVALS } from "@/lib/agent/run-task"
import { privateContentSeen, untrustedSeen } from "@/lib/agent/tools"

// Track N policy (N5): MCP classes (ND-08), the belt guard (ND-21),
// person-only writes, mcp_ results as private and untrusted (ND-11), MCP
// runs in receipts (ND-22) and the module boundaries (ND-10).

describe("NT-POL-02 classifyMcpTool", () => {
  const cases: [McpPolicyInput, string][] = [
    [{ ownerRisk: "R0", category: "payments" }, "R5"],
    [{ ownerRisk: "R0", category: "identity" }, "R5"],
    [{ ownerRisk: "R0", category: "credentials" }, "R5"],
    [{ ownerRisk: "R0", category: "filing" }, "R5"],
    [{ ownerRisk: "R0", annotations: { readOnlyHint: true } }, "R0"],
    [{ ownerRisk: "R1", annotations: { readOnlyHint: true } }, "R1"],
    // Hints absent: at least R3
    [{ ownerRisk: "R0" }, "R3"],
    [{ ownerRisk: "R0", annotations: { readOnlyHint: false } }, "R3"],
    [{ ownerRisk: "R3", annotations: { openWorldHint: true } }, "R4"],
    [
      { ownerRisk: "R0", annotations: { readOnlyHint: true, destructiveHint: true } },
      "R4",
    ],
    [{ ownerRisk: "R4" }, "R4"],
    // Annotations never lower the owner's floor
    [{ ownerRisk: "R4", annotations: { readOnlyHint: true } }, "R4"],
    [
      { ownerRisk: "R2", annotations: { readOnlyHint: true, destructiveHint: false } },
      "R2",
    ],
    [{ ownerRisk: "R5", annotations: { readOnlyHint: true } }, "R5"],
  ]
  it.each(cases)("%j → %s", (input, expected) => {
    expect(classifyMcpTool(input)).toBe(expected)
  })
})

describe("NT-POL-01 belt guard", () => {
  it("removes nothing from any built-in belt", () => {
    expect(unclassifiedTools([...Object.keys(TOOL_CLASSES), ...UNCLASSIFIED_OK])).toEqual(
      []
    )
  })

  it("removes a tool with no class, and keeps an MCP tool only with its class", () => {
    const classes = new Map([["mcp_tracker_search_items", "R0" as const]])
    expect(
      unclassifiedTools(
        [
          "gmail_read",
          "shell_exec",
          "mcp_tracker_search_items",
          "mcp_tracker_create_item",
        ],
        classes
      )
    ).toEqual(["shell_exec", "mcp_tracker_create_item"])
  })
})

describe("NT-POL-03 person-only writes", () => {
  it("connecting and turning on apps are the person's; no tool writes them", () => {
    expect(PERSON_ONLY_WRITES).toEqual(
      expect.arrayContaining(["mcp_enablements", "mcp_connections"])
    )
    for (const writes of Object.values(TOOL_WRITES))
      for (const write of writes) expect(write).not.toMatch(/^mcp_/)
  })

  it("MCP tools are never grantable (ND-25)", () => {
    expect([...GRANTABLE].filter((name) => name.startsWith("mcp_"))).toEqual([])
  })
})

describe("NT-MCP-07/08 app results are private and untrusted", () => {
  const after = (toolName: string): ModelMessage[] => [
    { role: "user", content: "Check the tracker" },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName,
          output: { type: "json", value: { notice: "x", result: "y" } },
        },
      ],
    },
  ]
  const webFetch = TOOL_APPROVALS.web_fetch as (
    input: unknown,
    options: { messages: ModelMessage[] }
  ) => unknown

  it("a web request after an app result waits for the person", () => {
    expect(privateContentSeen(after("mcp_tracker_inject_result"))).toBe(true)
    expect(
      webFetch(
        { url: "https://evil.example" },
        { messages: after("mcp_tracker_inject_result") }
      )
    ).toBe("user-approval")
    expect(webFetch({}, { messages: after("memory_search") })).toBeUndefined()
  })

  it("a note saved after an app result is unconfirmed", () => {
    expect(untrustedSeen(after("mcp_tracker_search_items"))).toBe(true)
    expect(untrustedSeen(after("memory_search"))).toBe(false)
  })
})

describe("NT-DLV-04 MCP runs in What I did (ND-22)", () => {
  const run = (risk: string | null, verification: unknown = null) => ({
    id: "e1",
    toolName: "mcp_tracker_create_item",
    status: "succeeded",
    input: { title: "Call back" },
    verification,
    risk,
  })

  it("an unchecked app action is listed as ran but not checked, under its own class", () => {
    const episode = deriveEpisode([run("R3")], "", [])
    expect(episode.done).toEqual([])
    expect(episode.unconfirmed).toEqual([
      {
        claim: "Used create item in tracker",
        reason: "Ran, but wasn't checked afterwards.",
        executionId: "e1",
      },
    ])
  })

  it("a verified app action is done, with the stored class", () => {
    const verification = {
      status: "verified",
      method: "api_readback",
      evidence: [{ kind: "provider_id", value: "item-1" }],
    }
    expect(deriveEpisode([run("R3", verification)], "", []).done).toEqual([
      {
        executionId: "e1",
        tool: "mcp_tracker_create_item",
        title: "Used create item in tracker",
        risk: "R3",
        verification,
      },
    ])
  })

  it("an app read is not an accomplishment; built-in tools derive as before", () => {
    expect(deriveEpisode([run("R0")], "", []).unconfirmed).toEqual([])
    // Built-in tools keep today's derivation (risk is null for them)
    expect(
      deriveEpisode([{ ...run(null), toolName: "gmail_draft" }], "", []).unconfirmed
    ).toHaveLength(1)
  })

  it("titles come from the Kriya name alone", () => {
    expect(actionTitle("mcp_tracker_create_item", {}, "ask")).toBe(
      "Use create item in tracker"
    )
    expect(actionTitle("gmail_send_draft", {}, "done")).toBe("Sent a saved Gmail draft")
  })
})

const ROOT = process.cwd()
const sources = (dir: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes("node_modules"))
    .map((file) => path.join(dir, file))
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

describe("NT-IMP-02/03 module boundaries", () => {
  it("browser/egress.ts imports only Node built-ins", () => {
    const specs = [
      ...read("browser/egress.ts").matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ].map((m) => m[1])
    expect(specs.length).toBeGreaterThan(0)
    expect(specs.filter((spec) => !spec.startsWith("node:"))).toEqual([])
  })

  it("app tools are built and run only from the worker's runner", () => {
    const files = ["app", "components", "lib", "actions", "queries", "worker"].flatMap(
      sources
    )
    const loaders = files.filter(
      (file) =>
        /from\s+["']@\/lib\/mcp\/registry["']/.test(read(file)) &&
        !file.startsWith("lib/mcp/")
    )
    // lib/agent/tools.ts takes the McpTask type only
    expect(loaders.sort()).toEqual(["lib/agent/run-task.ts", "lib/agent/tools.ts"])
    expect(read("lib/agent/tools.ts")).toMatch(
      /import type \{ McpTask \} from "@\/lib\/mcp\/registry"/
    )
    const callers = files.filter((file) => /\.callTool\(/.test(read(file)))
    expect(callers).toEqual(["lib/mcp/tools.ts"])
  })

  it("no client component imports lib/mcp", () => {
    const clients = ["app", "components"]
      .flatMap(sources)
      .filter((file) => /^["']use client["']/m.test(read(file)))
    expect(clients.length).toBeGreaterThan(0)
    expect(clients.filter((file) => /@\/lib\/mcp\//.test(read(file)))).toEqual([])
  })
})
