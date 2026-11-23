import { deviceMcpServers } from "@/lib/harness/mcp"
import { fail, harnessRoute } from "@/lib/harness/route"

// Harness 2.0 W16, MCP P3a: the registry servers this device may use, with
// each tool's pinned hash and class; never a token. 404 while harness.mcp or
// next.mcp is off
export const GET = harnessRoute(true, async (_request, device) => {
  const servers = await deviceMcpServers(device)
  if (!servers) return fail(404, "not_found", "Not found.")
  return Response.json({ servers }, { headers: { "cache-control": "no-store" } })
})
