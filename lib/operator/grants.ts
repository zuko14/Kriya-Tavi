import { and, eq, gt, lt, sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { goals, grants, mandates, type Grant } from "@/db/schema"
import { CAPABILITIES, GRANTABLE } from "@/lib/agent/capabilities"
import { partJobId } from "@/lib/operator/crew-threads"

// Standing grants in the runner (track O, O4; ARCHITECTURE §5). A call that
// would ask the person is answered "approved" only when it's a grantable
// tool, every pinned field is inside a grant the person approved for this
// job, and SQL spent one of its uses for this exact tool call. Anything
// else asks exactly as before. Grants never change a risk class (OD-03).

export type ActiveGrant = Pick<
  Grant,
  "id" | "tool" | "pins" | "maxUses" | "uses" | "expiresAt"
>

// What the person still reviews in the draft, event or sheet itself; any
// other field the registry doesn't pin means no match (DATA_MODEL §2.2)
const CONTENT = new Set([
  "subject",
  "body",
  "title",
  "start",
  "end",
  "timeZone",
  "description",
  "location",
  "rows",
])

const email = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : null

// Every value in `allowed`; absent counts as none
function within(values: unknown, allowed: unknown) {
  if (values === undefined) return true
  if (!Array.isArray(values)) return false
  const pinned = new Set(Array.isArray(allowed) ? allowed.map(email) : [])
  return values.every((value) => {
    const address = email(value)
    return address !== null && pinned.has(address)
  })
}

// Pure, like lib/agent/policy.ts
export function grantMatches(grant: ActiveGrant, tool: string, input: unknown) {
  const pinsOf = CAPABILITIES[tool]?.pins
  if (grant.tool !== tool || !GRANTABLE.has(tool) || !pinsOf) return false
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const pins = grant.pins as Record<string, unknown>
  for (const [field, value] of Object.entries(input)) {
    const how = pinsOf[field]
    if (!how) {
      if (CONTENT.has(field)) continue
      return false
    }
    if (how === "subset" ? !within(value, pins[field]) : value !== pins[field])
      return false
  }
  // An equals pin the call leaves out isn't the pinned target
  return Object.entries(pinsOf).every(
    ([field, how]) => how !== "equals" || field in input
  )
}

type Status = unknown
type Rule = Status | ((input: unknown, options: { toolCallId: string }) => Status)

// The approval map with grants on top. Only grantable tools that hold a
// grant are wrapped; every other rule is the same object as in `base`.
export function withGrants<T extends Record<string, unknown>>(
  base: T,
  held: ActiveGrant[],
  consume: (grantId: string, toolCallId: string) => Promise<boolean>
): T {
  // The narrowest first: fewest uses left, then the soonest to expire
  const order = [...held].sort(
    (a, b) =>
      a.maxUses - a.uses - (b.maxUses - b.uses) ||
      a.expiresAt.getTime() - b.expiresAt.getTime()
  )
  const next: Record<string, unknown> = { ...base }
  for (const tool of new Set(order.map((g) => g.tool).filter((t) => GRANTABLE.has(t)))) {
    const rule = base[tool] as Rule
    next[tool] = async (input: unknown, options: { toolCallId: string }) => {
      const status = typeof rule === "function" ? await rule(input, options) : rule
      if (status !== "user-approval") return status
      for (const grant of order) {
        if (!grantMatches(grant, tool, input)) continue
        // One use per call; a grant SQL refuses (revoked, expired, used up) passes to the next
        if (await consume(grant.id, options.toolCallId)) return "approved"
      }
      return "user-approval"
    }
  }
  return next as T
}

// Live grants of the active job whose goal thread this is, or whose working
// crew this part thread is in (O11); any other thread gets none.
// Privileged, so scoped by the person's id in every join.
export async function activeGrants(
  userId: string,
  threadId: string
): Promise<ActiveGrant[]> {
  const viaCrew = await partJobId(userId, threadId)
  return privileged
    .select({
      id: grants.id,
      tool: grants.tool,
      pins: grants.pins,
      maxUses: grants.maxUses,
      uses: grants.uses,
      expiresAt: grants.expiresAt,
    })
    .from(grants)
    .innerJoin(
      mandates,
      and(eq(mandates.id, grants.mandateId), eq(mandates.userId, grants.userId))
    )
    .innerJoin(
      goals,
      and(eq(goals.id, mandates.goalId), eq(goals.userId, mandates.userId))
    )
    .where(
      and(
        eq(grants.userId, userId),
        viaCrew ? eq(mandates.id, viaCrew) : eq(goals.threadId, threadId),
        eq(mandates.status, "active"),
        eq(grants.status, "active"),
        gt(grants.expiresAt, sql`now()`),
        lt(grants.uses, grants.maxUses)
      )
    )
}

// kriya.consume_grant: locks the grant, re-checks it and its job, and spends
// one use for this tool call (a retry of the same call spends nothing)
export async function consumeGrant(
  userId: string,
  grantId: string,
  taskId: string,
  toolCallId: string
) {
  const result = await privileged.execute(
    sql`select kriya.consume_grant(${userId}, ${grantId}, ${taskId}, ${toolCallId}) as ok`
  )
  return rowsOf<{ ok: boolean }>(result)[0]?.ok === true
}
