import { relations } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { createInsertSchema } from "drizzle-zod"
import { nanoid } from "nanoid"
import { z } from "zod"

import { TIERS, type Tier } from "@/lib/tiers"

// Types for the tables in supabase/migrations. The SQL there is the source
// of truth (it also holds the RLS policies and queue functions); keep this
// file in step with it.

export const kriya = pgSchema("kriya")

const id = () =>
  text()
    .primaryKey()
    .$defaultFn(() => nanoid(12))

const at = () => timestamp({ withTimezone: true, mode: "date" })
const createdAt = () => at().notNull().defaultNow()
// Money in integer micro-units; JS numbers are exact up to 2^53 (≈ ₹9 billion)
const micro = () => bigint({ mode: "number" })

/* ───────────────────────────── accounts ─────────────────────────── */

export const profiles = kriya.table("profiles", {
  id: uuid().primaryKey(),
  displayName: text(),
  locale: text().notNull().default("en-IN"),
  useCase: text(),
  status: text({ enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  suspendedReason: text(),
  onboardedAt: at(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const platformRoles = kriya.table("platform_roles", {
  userId: uuid().primaryKey(),
  role: text({ enum: ["owner"] }).notNull(),
  grantedBy: uuid(),
  createdAt: createdAt(),
})

/* ───────────────────────────── plans ────────────────────────────── */

export { TIERS, type Tier }

export const plans = kriya.table("plans", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  priceMonthlyPaise: micro(),
  includedUsageMicroInr: micro().notNull().default(0),
  markupBps: integer().notNull().default(10000),
  maxAgents: integer().notNull(),
  maxConcurrentTasks: integer().notNull(),
  maxTasksPerDay: integer().notNull(),
  maxTaskSeconds: integer().notNull(),
  maxSteps: integer().notNull(),
  maxTaskCostMicroUsd: micro().notNull(),
  allowedTiers: text().array().notNull().$type<Tier[]>(),
  browserMinutes: integer().notNull().default(0),
  overageAllowed: boolean().notNull().default(false),
  overageCapMicroInr: micro().notNull().default(0),
  warnAtPct: integer().notNull().default(80),
  isDefault: boolean().notNull().default(false),
  active: boolean().notNull().default(false),
  sort: integer().notNull().default(0),
  razorpayPlanId: text(),
  updatedAt: createdAt(),
})

export const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "past_due",
  "halted",
  "canceled",
  "expired",
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export const subscriptions = kriya.table("subscriptions", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  planId: text().notNull(),
  status: text({ enum: SUBSCRIPTION_STATUSES }).notNull(),
  provider: text({ enum: ["razorpay", "test"] }).notNull(),
  providerSubscriptionId: text().notNull(),
  currentPeriodStart: at(),
  currentPeriodEnd: at(),
  cancelAtPeriodEnd: boolean().notNull().default(false),
  lastEventAt: at(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const payments = kriya.table("payments", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid(),
  subscriptionId: uuid(),
  provider: text().notNull(),
  providerPaymentId: text().notNull(),
  amountPaise: micro().notNull(),
  feePaise: micro(),
  taxPaise: micro(),
  currency: text().notNull().default("INR"),
  status: text({ enum: ["captured", "refunded", "failed"] }).notNull(),
  paidAt: at(),
  createdAt: createdAt(),
})

export const billingEvents = kriya.table("billing_events", {
  id: uuid().primaryKey().defaultRandom(),
  provider: text().notNull(),
  eventId: text().notNull(),
  type: text().notNull(),
  payload: jsonb().notNull(),
  receivedAt: createdAt(),
  processedAt: at(),
  error: text(),
})

/* ───────────────────────────── agents ───────────────────────────── */

export const agents = kriya.table("agents", {
  id: id(),
  userId: uuid().notNull(),
  name: text().notNull(),
  // One line describing what the agent is for
  role: text().notNull(),
  // Standing orders appended to the agent's system prompt
  instructions: text(),
  // A routing tier; null uses the default tier
  model: text(),
  // Seed for the agent's generated glyph
  glyph: text()
    .notNull()
    .$defaultFn(() => nanoid(10)),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const squads = kriya.table("squads", {
  id: id(),
  userId: uuid().notNull(),
  name: text().notNull(),
  createdAt: createdAt(),
})

export const squadMembers = kriya.table(
  "squad_members",
  {
    squadId: text().notNull(),
    agentId: text().notNull(),
    userId: uuid().notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.squadId, t.agentId] })]
)

/* ───────────────────────────── threads ──────────────────────────── */

// A conversation with one agent (agentId) or with a squad (squadId)
export const threads = kriya.table("threads", {
  id: id(),
  userId: uuid().notNull(),
  agentId: text(),
  squadId: text(),
  title: text(),
  preview: text(),
  activeAt: createdAt(),
  createdAt: createdAt(),
})

export const messages = kriya.table(
  "messages",
  {
    threadId: text().notNull(),
    // UI message id, assigned by the client (user) or the stream (assistant)
    id: text().notNull(),
    userId: uuid().notNull(),
    role: text({ enum: ["user", "assistant", "system"] }).notNull(),
    parts: jsonb().notNull().$type<unknown[]>(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.id] })]
)

/* ───────────────────────────── memory ───────────────────────────── */

// Long-term notes an agent keeps about the person and their work. Shared
// across every thread the agent takes part in.
export const memories = kriya.table("memories", {
  id: id(),
  userId: uuid().notNull(),
  agentId: text().notNull(),
  content: text().notNull(),
  source: text({ enum: ["agent", "user"] })
    .notNull()
    .default("agent"),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

/* ─────────────────────────── connections ────────────────────────── */

export const CONNECTION_PROVIDERS = ["google", "notion"] as const
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number]

// Tokens are ciphertext from lib/secrets.ts, never plaintext; the person's
// session can't select those two columns at all
export const connections = kriya.table("connections", {
  id: id(),
  userId: uuid().notNull(),
  provider: text({ enum: CONNECTION_PROVIDERS }).notNull(),
  account: text(),
  scopes: text().array().notNull().default([]),
  accessToken: text().notNull(),
  refreshToken: text(),
  expiresAt: at(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

/* ───────────────────────────── tasks ────────────────────────────── */

export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export type TaskInput = {
  messageId: string
  agentId: string
  channel: "web"
}

export const tasks = kriya.table("tasks", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  threadId: text().notNull(),
  agentId: text(),
  status: text({ enum: TASK_STATUSES }).notNull().default("queued"),
  input: jsonb().notNull().$type<TaskInput>(),
  planId: text().notNull(),
  tier: text({ enum: TIERS }).notNull(),
  model: text(),
  attempts: integer().notNull().default(0),
  maxAttempts: integer().notNull().default(3),
  availableAt: createdAt(),
  deadlineAt: at().notNull(),
  leaseOwner: text(),
  leaseExpiresAt: at(),
  heartbeatAt: at(),
  cancelRequestedAt: at(),
  idempotencyKey: text(),
  stepBudget: integer().notNull(),
  costBudgetMicroUsd: micro().notNull(),
  errorCode: text(),
  error: text(),
  createdAt: createdAt(),
  startedAt: at(),
  finishedAt: at(),
  updatedAt: createdAt(),
})

export const taskAttempts = kriya.table(
  "task_attempts",
  {
    taskId: uuid().notNull(),
    attempt: integer().notNull(),
    userId: uuid().notNull(),
    workerId: text().notNull(),
    tier: text().notNull(),
    model: text().notNull(),
    status: text({ enum: ["running", "succeeded", "failed", "canceled", "lost"] })
      .notNull()
      .default("running"),
    errorCode: text(),
    error: text(),
    startedAt: createdAt(),
    finishedAt: at(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.attempt] })]
)

export const taskEvents = kriya.table("task_events", {
  id: bigserial({ mode: "number" }).primaryKey(),
  taskId: uuid().notNull(),
  userId: uuid().notNull(),
  attempt: integer().notNull(),
  seq: integer().notNull(),
  chunks: jsonb().notNull().$type<unknown[]>(),
  createdAt: createdAt(),
})

export const toolExecutions = kriya.table("tool_executions", {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull(),
  userId: uuid().notNull(),
  attempt: integer().notNull(),
  toolCallId: text().notNull(),
  toolName: text().notNull(),
  sideEffect: boolean().notNull().default(false),
  status: text({ enum: ["running", "succeeded", "failed"] })
    .notNull()
    .default("running"),
  input: jsonb(),
  outputSummary: text(),
  evidence: jsonb(),
  error: text(),
  startedAt: createdAt(),
  finishedAt: at(),
  durationMs: integer(),
})

/* ───────────────────────────── metering ─────────────────────────── */

export const usageEvents = kriya.table("usage_events", {
  id: uuid().primaryKey().defaultRandom(),
  requestKey: text().notNull().unique(),
  userId: uuid(),
  taskId: uuid(),
  attempt: integer(),
  step: integer(),
  provider: text().notNull(),
  model: text().notNull(),
  tier: text(),
  generationId: text(),
  inputTokens: integer(),
  outputTokens: integer(),
  reasoningTokens: integer(),
  cachedTokens: integer(),
  usageStatus: text({ enum: ["reported", "missing"] }).notNull(),
  costMicroUsd: micro(),
  costSource: text({ enum: ["provider", "estimate", "reconciled"] }),
  estimatedCostMicroUsd: micro(),
  latencyMs: integer(),
  finishReason: text(),
  error: text(),
  raw: jsonb(),
  createdAt: createdAt(),
})

export const charges = kriya.table("charges", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid(),
  taskId: uuid().unique(),
  planId: text(),
  providerCostMicroUsd: micro().notNull().default(0),
  costBasis: text({ enum: ["provider", "estimate", "none"] }).notNull(),
  unmeteredRequests: integer().notNull().default(0),
  fxUsdInr: numeric({ precision: 12, scale: 4 }),
  fxSource: text(),
  providerCostMicroInr: micro(),
  markupBps: integer().notNull(),
  chargeMicroInr: micro(),
  status: text({ enum: ["final", "estimated", "unpriced"] }).notNull(),
  createdAt: createdAt(),
})

/* ───────────────────────────── platform ─────────────────────────── */

export const models = kriya.table("models", {
  id: text().primaryKey(),
  label: text().notNull(),
  provider: text().notNull().default("openrouter"),
  enabled: boolean().notNull().default(false),
  supportsTools: boolean().notNull().default(false),
  supportsStructured: boolean().notNull().default(false),
  supportsImages: boolean().notNull().default(false),
  inputMicroUsdPerMtok: micro(),
  outputMicroUsdPerMtok: micro(),
  pricesCheckedAt: at(),
  evalStatus: text({ enum: ["untested", "passed", "failed"] })
    .notNull()
    .default("untested"),
  evalNotes: text(),
  evaluatedAt: at(),
  updatedAt: createdAt(),
})

export const platformSettings = kriya.table("platform_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedBy: uuid(),
  updatedAt: createdAt(),
})

export const auditEvents = kriya.table("audit_events", {
  id: bigserial({ mode: "number" }).primaryKey(),
  actorId: uuid(),
  action: text().notNull(),
  targetType: text(),
  targetId: text(),
  details: jsonb(),
  createdAt: createdAt(),
})

export const workers = kriya.table("workers", {
  id: text().primaryKey(),
  version: text(),
  concurrency: integer().notNull(),
  running: integer().notNull().default(0),
  startedAt: createdAt(),
  heartbeatAt: createdAt(),
  stoppedAt: at(),
})

/* ──────────────────────────── relations ─────────────────────────── */

export const agentsRelations = relations(agents, ({ many }) => ({
  squads: many(squadMembers),
  threads: many(threads),
  memories: many(memories),
}))

export const squadsRelations = relations(squads, ({ many }) => ({
  members: many(squadMembers),
  threads: many(threads),
}))

export const squadMembersRelations = relations(squadMembers, ({ one }) => ({
  squad: one(squads, { fields: [squadMembers.squadId], references: [squads.id] }),
  agent: one(agents, { fields: [squadMembers.agentId], references: [agents.id] }),
}))

export const threadsRelations = relations(threads, ({ one, many }) => ({
  agent: one(agents, { fields: [threads.agentId], references: [agents.id] }),
  squad: one(squads, { fields: [threads.squadId], references: [squads.id] }),
  messages: many(messages),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(threads, { fields: [messages.threadId], references: [threads.id] }),
}))

export const memoriesRelations = relations(memories, ({ one }) => ({
  agent: one(agents, { fields: [memories.agentId], references: [agents.id] }),
}))

/* ──────────────────────────── validation ────────────────────────── */

export const tierSchema = z.enum(TIERS)

export const agentInputSchema = createInsertSchema(agents, {
  name: (s) =>
    s.trim().min(1, "Give the agent a name.").max(40, "Keep it under 40 characters."),
  role: (s) =>
    s
      .trim()
      .min(1, "Describe what the agent is for.")
      .max(120, "Keep it under 120 characters."),
  instructions: (s) => s.trim().max(6000, "Keep it under 6000 characters."),
  model: () => z.union([tierSchema, z.literal("")]),
  glyph: () => z.string().trim().min(1).max(32).optional(),
}).omit({ id: true, userId: true, createdAt: true, updatedAt: true })

export const squadInputSchema = createInsertSchema(squads, {
  name: (s) => s.trim().min(1, "Name the squad.").max(40, "Keep it under 40 characters."),
})
  .omit({ id: true, userId: true, createdAt: true })
  .extend({
    agentIds: z.array(z.string().max(32)).min(2, "A squad needs at least two agents."),
  })

export const memoryInputSchema = z.object({
  content: z.string().trim().min(1, "Write something to remember.").max(2000),
})

export const LOCALES = [
  "en-IN",
  "hi-IN",
  "te-IN",
  "ta-IN",
  "bn-IN",
  "mr-IN",
  "kn-IN",
] as const
export const USE_CASES = [
  "student",
  "developer",
  "founder",
  "creator",
  "freelancer",
  "business",
  "other",
] as const

export const profileInputSchema = z.object({
  displayName: z.string().trim().min(1, "Tell us what to call you.").max(60),
  locale: z.enum(LOCALES),
  useCase: z.enum(USE_CASES).optional(),
})

export type Agent = typeof agents.$inferSelect
export type AgentInput = z.infer<typeof agentInputSchema>
export type Squad = typeof squads.$inferSelect
export type SquadInput = z.infer<typeof squadInputSchema>
export type Thread = typeof threads.$inferSelect
export type Memory = typeof memories.$inferSelect
export type Connection = typeof connections.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Plan = typeof plans.$inferSelect
export type Profile = typeof profiles.$inferSelect
