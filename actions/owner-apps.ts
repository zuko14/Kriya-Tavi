"use server"

import { isIP } from "node:net"

import { and, eq, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { OwnerState } from "@/actions/owner"
import { isBlockedHost } from "@/browser/egress"
import { privileged } from "@/db"
import { mcpServers, mcpTools, RISK_CLASSES } from "@/db/schema"
import { classifyMcpTool, type McpPolicyInput } from "@/lib/agent/policy"
import { isUniqueViolation } from "@/lib/agent/queue"
import { requireOwner } from "@/lib/auth"
import { log } from "@/lib/log"
import { liveAsOwner } from "@/lib/mcp/live"
import { RECORDED } from "@/lib/mcp/recorded"
import { definitionHash, pinnedDefinition, pinnedSchema } from "@/lib/mcp/tools"
import { verifySpecSchema } from "@/lib/mcp/verify"
import { audit } from "@/lib/owner"

// The owner's registry of apps (N7, ND-06/07/12; TOOLS_AND_CONTRACTS §6).
// Every action re-checks the role on the server and leaves an audit record
// with ids and hashes, never a definition or a note. None of them can be
// reached by an agent: nothing here is a tool (track-A rule 11).

const PAGE = "/owner/apps"

const field = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === "string" ? value.trim() : ""
}
const optional = (form: FormData, name: string) => field(form, name) || undefined
const list = (form: FormData, name: string) =>
  field(form, name)
    .split(/[\s,]+/)
    .filter(Boolean)

// A message for the owner: our own wording, or a rule the database itself
// raised (its text names no row data); anything else is logged and kept out
function fail(error: unknown): OwnerState {
  if (error instanceof z.ZodError)
    return { error: error.issues[0]?.message ?? "Invalid." }
  if (error instanceof Error && error.name === "OwnerError")
    return { error: error.message }
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause
  if (cause?.code === "P0001" && cause.message) return { error: cause.message }
  log.error("owner apps action failed", { error: (error as Error)?.name ?? "error" })
  return { error: "That didn't save." }
}
class OwnerError extends Error {
  name = "OwnerError"
}
const refuse = (message: string): never => {
  throw new OwnerError(message)
}

// https only, a name (no IP address) the egress guard accepts (NT-OWN-04)
const safeOrigin = (value: string) => {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 &&
      !isBlockedHost(url.hostname)
    )
  } catch {
    return false
  }
}

const serverFields = z.object({
  id: z.string().regex(/^[a-z]{2,12}$/, "The id is 2 to 12 lowercase letters."),
  name: z.string().min(1, "Give it a name.").max(60),
  url: z
    .string()
    .max(300)
    .refine(safeOrigin, "The address must be https and a public name."),
  auth: z.enum(["oauth_public", "oauth_cimd", "oauth_confidential", "none"]),
  clientId: z.string().max(300).optional(),
  secretEnv: z
    .string()
    .regex(/^KRIYA_MCP_[A-Z0-9_]{2,40}$/, "The secret's name starts KRIYA_MCP_.")
    .optional(),
  scopes: z.array(z.string().max(100)).max(30),
  origins: z
    .array(z.string().max(300).refine(safeOrigin, "Sign-in addresses must be https."))
    .max(4, "At most 4 sign-in addresses."),
  transport: z.enum(["http", "sse"]),
  review: z.string().max(4000).optional(),
})
// A new app also has to be consistent about how people sign in
const serverSchema = serverFields
  .refine((s) => (s.auth === "oauth_confidential") === (s.secretEnv !== undefined), {
    message: "Only a confidential client has a secret name.",
  })
  .refine((s) => s.auth === "none" || s.auth === "oauth_cimd" || s.clientId, {
    message: "This sign-in needs a client id.",
  })

export async function addServer(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const s = serverSchema.parse({
      id: field(form, "id"),
      name: field(form, "name"),
      url: field(form, "url"),
      auth: field(form, "auth"),
      clientId: optional(form, "clientId"),
      secretEnv: optional(form, "secretEnv"),
      scopes: list(form, "scopes"),
      origins: list(form, "origins"),
      transport: field(form, "transport") || "http",
      review: optional(form, "review"),
    })
    await privileged.insert(mcpServers).values({
      id: s.id,
      name: s.name,
      url: s.url,
      auth: s.auth,
      clientId: s.clientId ?? null,
      secretEnv: s.secretEnv ?? null,
      scopes: s.scopes,
      allowedAuthOrigins: s.origins,
      transport: s.transport,
      review: s.review ?? null,
      createdBy: owner.id,
    })
    await audit(owner.id, "mcp.server.add", { type: "mcp_server", id: s.id })
    revalidatePath(PAGE)
    return { message: "Added as a draft." }
  } catch (error) {
    if (isUniqueViolation(error, "mcp_servers_pkey"))
      return { error: "That id is taken." }
    return fail(error)
  }
}

// The address, sign-in and id stay as they were: a different address is a
// different app (retire this one and add that one)
export async function updateServer(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const id = z
      .string()
      .regex(/^[a-z]{2,12}$/)
      .parse(field(form, "id"))
    const s = serverFields
      .pick({ name: true, scopes: true, origins: true, review: true })
      .parse({
        name: field(form, "name"),
        scopes: list(form, "scopes"),
        origins: list(form, "origins"),
        review: optional(form, "review"),
      })
    const updated = await privileged
      .update(mcpServers)
      .set({
        name: s.name,
        scopes: s.scopes,
        allowedAuthOrigins: s.origins,
        review: s.review ?? null,
      })
      .where(and(eq(mcpServers.id, id), sql`${mcpServers.status} <> 'retired'`))
      .returning({ id: mcpServers.id })
    if (updated.length === 0) return { error: "No such app, or it is retired." }
    await audit(owner.id, "mcp.server.update", { type: "mcp_server", id })
    revalidatePath(PAGE)
    return { message: "Saved." }
  } catch (error) {
    return fail(error)
  }
}

export async function setServerStatus(
  _: OwnerState,
  form: FormData
): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const id = z
      .string()
      .regex(/^[a-z]{2,12}$/)
      .parse(field(form, "id"))
    const status = z.enum(["active", "suspended", "retired"]).parse(field(form, "status"))
    const [server] = await privileged
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
    if (!server) return { error: "No such app." }
    if (status === "active" && server.status === "draft") {
      // Pinned tools and a recorded-response test for each (NT-MCP-20)
      const pinned = await privileged
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(and(eq(mcpTools.serverId, id), eq(mcpTools.status, "pinned")))
      if (pinned.length === 0) return { error: "Pin at least one tool first." }
      const untested = pinned.filter((t) => !RECORDED[id]?.includes(t.name))
      if (untested.length > 0)
        return {
          error: `No recorded-response test yet for: ${untested.map((t) => t.name).join(", ")}.`,
        }
    }
    await privileged.update(mcpServers).set({ status }).where(eq(mcpServers.id, id))
    await audit(owner.id, `mcp.server.${status}`, { type: "mcp_server", id })
    revalidatePath(PAGE)
    return { message: `Now ${status}.` }
  } catch (error) {
    return fail(error)
  }
}

const pinSchema = z.object({
  serverId: z.string().regex(/^[a-z]{2,12}$/),
  name: z.string().min(1).max(128),
  kriyaName: z
    .string()
    .max(40)
    .regex(
      /^mcp_[a-z]{2,12}_[a-z_]{2,22}$/,
      "Kriya's name looks like mcp_app_tool_name."
    ),
  description: z.string().min(1, "Describe it in your own words.").max(400),
  ownerRisk: z.enum(RISK_CLASSES),
  category: z.enum(["payments", "identity", "credentials", "filing"]).optional(),
  idempotent: z.boolean(),
})

const JSON_LIMIT = 60_000

function parseJson(text: string, what: string): unknown {
  if (text.length > JSON_LIMIT) refuse(`${what} is too long.`)
  try {
    return JSON.parse(text)
  } catch {
    return refuse(`${what} isn't valid JSON.`)
  }
}

const READ_ERRORS = {
  connect:
    "Sign in to this app yourself in Account → Apps first, or paste the definition.",
  reconnect: "Your sign-in to this app stopped working; reconnect it first.",
  unreachable: "The app didn't answer. Try again, or paste the definition.",
} as const

export async function pinTool(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const pin = pinSchema.parse({
      serverId: field(form, "serverId"),
      name: field(form, "name"),
      kriyaName: field(form, "kriyaName"),
      description: field(form, "description"),
      ownerRisk: field(form, "ownerRisk"),
      category: optional(form, "category"),
      idempotent: form.get("idempotent") === "on",
    })
    if (!pin.kriyaName.startsWith(`mcp_${pin.serverId}_`))
      return { error: `Kriya's name starts mcp_${pin.serverId}_.` }
    if (pin.idempotent && pin.ownerRisk !== "R0")
      return { error: "Only a read (R0) can be repeated safely." }

    const [server] = await privileged
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, pin.serverId))
    if (!server || server.status === "retired") return { error: "No such app." }
    const [existing] = await privileged
      .select({ status: mcpTools.status })
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, pin.serverId), eq(mcpTools.name, pin.name)))
    if (existing && existing.status !== "disabled")
      return { error: "That tool is already pinned." }

    // The definition the owner read: pasted from the provider's own tool list
    // (an app nobody can sign in to yet), or fetched as the owner
    const pasted = optional(form, "definition")
    let found: Record<string, unknown> | undefined
    if (pasted) {
      const value = parseJson(pasted, "The definition")
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { error: "The definition is one tool's JSON object." }
      found = value as Record<string, unknown>
      if (found.name !== pin.name)
        return { error: "The definition has a different name." }
    } else {
      const read = await liveAsOwner(server, owner.id)
      if ("error" in read) return { error: READ_ERRORS[read.error] }
      found = read.live.get(pin.name)
      if (!found) return { error: "The app has no tool with that name." }
    }
    const definition = pinnedDefinition(found)
    if (JSON.stringify(definition).length > JSON_LIMIT)
      return { error: "That definition is too large to pin." }
    try {
      pinnedSchema(definition.inputSchema)
    } catch {
      return { error: "Its input schema can't be used." }
    }

    const verifyText = optional(form, "verify")
    let verify: z.infer<typeof verifySpecSchema> | null = null
    if (verifyText) {
      verify = verifySpecSchema.parse(parseJson(verifyText, "The read-back"))
      if (pin.ownerRisk === "R0" || pin.ownerRisk === "R1" || pin.category)
        return { error: "A read-back belongs to a tool that changes something." }
      // The read tool: pinned, same app, and a read by its own annotations (ND-12)
      const [reader] = await privileged
        .select()
        .from(mcpTools)
        .where(
          and(
            eq(mcpTools.serverId, pin.serverId),
            eq(mcpTools.name, verify.tool),
            eq(mcpTools.status, "pinned")
          )
        )
      if (
        !reader ||
        classifyMcpTool({
          ownerRisk: reader.ownerRisk,
          annotations: (reader.definition as Pick<McpPolicyInput, "annotations">)
            .annotations,
          category: reader.category,
        }) !== "R0"
      )
        return { error: "The read-back tool must be a pinned read (R0) in this app." }
    }

    const hash = definitionHash(definition)
    await privileged.transaction(async (tx) => {
      // A tool that was switched off is pinned afresh, from what the owner read now
      if (existing)
        await tx
          .delete(mcpTools)
          .where(and(eq(mcpTools.serverId, pin.serverId), eq(mcpTools.name, pin.name)))
      await tx.insert(mcpTools).values({
        serverId: pin.serverId,
        name: pin.name,
        kriyaName: pin.kriyaName,
        definition,
        definitionHash: hash,
        description: pin.description,
        ownerRisk: pin.ownerRisk,
        category: pin.category ?? null,
        idempotent: pin.idempotent,
        verify,
        approvedBy: owner.id,
      })
    })
    await audit(
      owner.id,
      "mcp.tool.pin",
      { type: "mcp_tool", id: pin.kriyaName },
      {
        risk: pin.ownerRisk,
        hash,
        readBack: verify !== null,
      }
    )
    revalidatePath(PAGE)
    return { message: "Pinned." }
  } catch (error) {
    if (isUniqueViolation(error, "mcp_tools_kriya_name_key"))
      return { error: "Another tool already has that name in Kriya." }
    return fail(error)
  }
}

// The owner has looked at the old and new definitions side by side and takes
// the new one. `seenHash` is the one on the screen; it must still be what the
// app says now (ND-07), so approving without looking can't pin a later change.
export async function approveDrift(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const serverId = z
      .string()
      .regex(/^[a-z]{2,12}$/)
      .parse(field(form, "serverId"))
    const name = z.string().min(1).max(128).parse(field(form, "name"))
    const seen = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(field(form, "seenHash"))
    const [tool] = await privileged
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)))
    if (!tool || tool.status !== "drifted" || !tool.driftedHash)
      return { error: "That tool has nothing to review." }
    if (tool.driftedHash !== seen)
      return { error: "It changed again since you looked. Review it again." }
    const [server] = await privileged
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
    if (!server) return { error: "No such app." }

    const read = await liveAsOwner(server, owner.id)
    if ("error" in read) return { error: READ_ERRORS[read.error] }
    const live = read.live.get(name)
    if (!live || definitionHash(live) !== seen)
      return { error: "The app shows something else now. Review it again." }
    const definition = pinnedDefinition(live)
    try {
      pinnedSchema(definition.inputSchema)
    } catch {
      return { error: "Its new input schema can't be used." }
    }
    const updated = await privileged
      .update(mcpTools)
      .set({
        definition,
        definitionHash: seen,
        status: "pinned",
        approvedBy: owner.id,
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(mcpTools.serverId, serverId),
          eq(mcpTools.name, name),
          eq(mcpTools.status, "drifted"),
          eq(mcpTools.driftedHash, seen)
        )
      )
      .returning({ name: mcpTools.name })
    if (updated.length === 0) return { error: "It changed while you were approving." }
    await audit(
      owner.id,
      "mcp.tool.approve_drift",
      { type: "mcp_tool", id: tool.kriyaName },
      {
        from: tool.definitionHash,
        to: seen,
      }
    )
    revalidatePath(PAGE)
    return { message: "The new definition is pinned." }
  } catch (error) {
    return fail(error)
  }
}

// Switch a tool off, or on again if the app still shows exactly what was pinned
export async function setToolStatus(_: OwnerState, form: FormData): Promise<OwnerState> {
  const owner = await requireOwner()
  try {
    const serverId = z
      .string()
      .regex(/^[a-z]{2,12}$/)
      .parse(field(form, "serverId"))
    const name = z.string().min(1).max(128).parse(field(form, "name"))
    const status = z.enum(["disabled", "pinned"]).parse(field(form, "status"))
    const [tool] = await privileged
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)))
    if (!tool) return { error: "No such tool." }
    if (status === "pinned") {
      const [server] = await privileged
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
      const read = await liveAsOwner(server, owner.id)
      if ("error" in read) return { error: READ_ERRORS[read.error] }
      const live = read.live.get(name)
      if (!live || definitionHash(live) !== tool.definitionHash)
        return { error: "The app changed this tool while it was off. Pin it again." }
    }
    await privileged
      .update(mcpTools)
      .set({ status })
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)))
    await audit(owner.id, `mcp.tool.${status}`, { type: "mcp_tool", id: tool.kriyaName })
    revalidatePath(PAGE)
    return { message: status === "disabled" ? "Switched off." : "Switched on." }
  } catch (error) {
    return fail(error)
  }
}
