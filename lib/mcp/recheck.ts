import { createMCPClient } from "@ai-sdk/mcp"
import { and, eq } from "drizzle-orm"

import { privileged } from "@/db"
import { mcpServers, mcpTools, type Verification } from "@/db/schema"
import { disabledTools } from "@/lib/agent/capabilities"
import { classifyMcpTool, type McpPolicyInput } from "@/lib/agent/policy"
import { getSetting } from "@/lib/config"
import { guardedFetch, OPEN_TIMEOUT_MS } from "@/lib/mcp/fetch"
import { connectedAuth } from "@/lib/mcp/live"
import { CALL_TIMEOUT_MS, definitionHash } from "@/lib/mcp/tools"
import { pointerGet, readBack, verifySpecSchema } from "@/lib/mcp/verify"
import { assertClosed } from "@/lib/reliability/breaker"

// The late re-check of an app run (ND-04, ND-12): the owner's read-back spec,
// run once more by the worker as the run's person, through the same guarded
// client. Reads only, and only a pinned, unchanged, R0 tool of the same app.
// Throws when it can't (spec gone, tool changed, not signed in, app down); the
// caller records that as "unverified". Obeys the same off switches as the
// runner: next.mcp (and agents.inbox), the app's status and the tool kill list.

// What the run's record kept of its input: redactInput (lib/agent/approvals.ts)
// replaces some values and cuts long inputs; comparing against those would
// call a good run "failed", so such a run can't be re-checked
const REDACTED = "[redacted]"

export async function mcpReadBack(
  userId: string,
  target: { kriyaName: string; input: unknown; result: unknown }
): Promise<Verification> {
  if (
    (await getSetting("next.mcp")) !== "on" ||
    (await getSetting("agents.inbox")) !== "on"
  )
    throw new Error("apps are off")
  const [pin] = await privileged
    .select()
    .from(mcpTools)
    .where(eq(mcpTools.kriyaName, target.kriyaName))
  const spec = verifySpecSchema.safeParse(pin?.verify)
  if (!pin || pin.status !== "pinned" || !spec.success) throw new Error("no read-back")
  const first = { input: target.input, structuredContent: target.result }
  const used = [...Object.values(spec.data.args), ...Object.values(spec.data.expect)]
  if (used.some((pointer) => pointerGet(first, pointer) === REDACTED))
    throw new Error("input not kept")
  const [reader] = await privileged
    .select()
    .from(mcpTools)
    .where(and(eq(mcpTools.serverId, pin.serverId), eq(mcpTools.name, spec.data.tool)))
  const [server] = await privileged
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, pin.serverId), eq(mcpServers.status, "active")))
  // The same rule as the first read-back: a pinned, unchanged, R0 read tool
  if (
    !reader ||
    reader.status !== "pinned" ||
    !server ||
    classifyMcpTool({
      ownerRisk: reader.ownerRisk,
      annotations: (reader.definition as Pick<McpPolicyInput, "annotations">).annotations,
      category: reader.category,
    }) !== "R0"
  )
    throw new Error("no read tool")
  const disabled = disabledTools(await getSetting("operator.disabledTools"))
  if (disabled.has(pin.kriyaName) || disabled.has(reader.kriyaName))
    throw new Error("switched off")
  // An app that keeps failing gets a rest (N4), as in the runner
  assertClosed(`mcp:${server.id}`)
  const auth = await connectedAuth(userId)(server)
  if (auth === null || auth === "reconnect") throw new Error("not signed in")
  const client = await createMCPClient({
    transport: {
      type: server.transport,
      url: server.url,
      fetch: guardedFetch(server),
      redirect: "error",
      ...(auth && { authProvider: auth }),
    },
    clientName: "kriya",
    initializationOptions: { timeout: OPEN_TIMEOUT_MS },
  })
  try {
    const listed = await client.listTools({ options: { timeout: OPEN_TIMEOUT_MS } })
    const live = listed.tools.find((tool) => tool.name === reader.name)
    if (!live || definitionHash(live) !== reader.definitionHash)
      throw new Error("read tool changed")
    return await readBack(spec.data, first, (args) =>
      client.callTool({
        name: spec.data.tool,
        arguments: args,
        options: { timeout: CALL_TIMEOUT_MS },
      })
    )
  } finally {
    await client.close().catch(() => {})
  }
}
