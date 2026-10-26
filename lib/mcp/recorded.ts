// NT-MCP-20 (MCP_CONNECTIVITY §9.7): the pinned tools that have a recorded-
// response test, by server id. The owner's "make active" refuses a server with
// a pinned tool that isn't listed here, so adding an app is a reviewed code
// change plus a recorded fixture (tests/fixtures/mcp/recorded/<id>.json, which
// tests/next/mcp-owner.test.ts checks for every entry). Empty until the first
// real server passes the review checklist (NB-04).
export const RECORDED: Record<string, readonly string[]> = {}
