import { relations } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  time,
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
  // Lite mode (K10): the person's own setting for slow networks; null until
  // they choose (the browser's save-data hint decides meanwhile)
  liteMode: boolean(),
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
  maxGoals: integer().notNull().default(3),
  maxSchedules: integer().notNull().default(3),
  minScheduleIntervalMinutes: integer().notNull().default(1440),
  maxSkills: integer().notNull().default(0),
  maxFileMb: integer().notNull().default(10),
  storageMb: integer().notNull().default(100),
  maxShares: integer().notNull().default(5),
  maxLoginProfiles: integer().notNull().default(0),
  ledgerEnabled: boolean().notNull().default(false),
  overageAllowed: boolean().notNull().default(false),
  overageCapMicroInr: micro().notNull().default(0),
  warnAtPct: integer().notNull().default(80),
  isDefault: boolean().notNull().default(false),
  active: boolean().notNull().default(false),
  sort: integer().notNull().default(0),
  razorpayPlanId: text(),
  updatedAt: createdAt(),
  // Voice (voice phase 1); 0 and false mean voice is off on the plan
  voiceEnabled: boolean().notNull().default(false),
  maxOutreachCallsPerDay: integer().notNull().default(0),
  maxCallSeconds: integer().notNull().default(300),
  maxAttemptsPerCall: integer().notNull().default(2),
  maxVoiceTaskCostMicroInr: micro().notNull().default(0),
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
  // Memory v2: the person paused this agent's memory (nothing is saved)
  memoryPaused: boolean().notNull().default(false),
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
// across every thread the agent takes part in; a null agentId is shared by
// all of the person's agents (memory v2). The generated `search` column is
// left out on purpose: lib/memory queries it in SQL, and nothing else
// should select it.
export const MEMORY_KINDS = [
  "profile",
  "preference",
  "instruction",
  "fact",
  "decision",
  "relationship",
] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const memories = kriya.table("memories", {
  id: id(),
  userId: uuid().notNull(),
  agentId: text(),
  content: text().notNull(),
  source: text({ enum: ["agent", "user", "derived"] })
    .notNull()
    .default("agent"),
  kind: text({ enum: MEMORY_KINDS }).notNull().default("fact"),
  slot: text(),
  trust: text({ enum: ["trusted", "unconfirmed"] })
    .notNull()
    .default("trusted"),
  importance: integer().notNull().default(2),
  pinned: boolean().notNull().default(false),
  validFrom: createdAt(),
  invalidAt: at(),
  supersededBy: text(),
  taskId: uuid(),
  archived: boolean().notNull().default(false),
  lastUsedAt: at(),
  useCount: integer().notNull().default(0),
  contentHash: text(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

// Checkpoints of a thread's older turns (memory v2), written by the worker
export const threadSummaries = kriya.table("thread_summaries", {
  id: id(),
  userId: uuid().notNull(),
  threadId: text().notNull(),
  coversThrough: at().notNull(),
  summary: jsonb().notNull().$type<ThreadSummary>(),
  chars: integer().notNull(),
  model: text(),
  createdAt: createdAt(),
})

export type ThreadSummary = {
  facts: string[]
  decisions: string[]
  open_questions: string[]
  pending_actions: string[]
  numbers: string[]
}

// Background model work that must not hold a thread's task slot
export const maintenanceJobs = kriya.table("maintenance_jobs", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  kind: text({ enum: ["thread_summary", "episode_summary", "consolidate"] }).notNull(),
  ref: text().notNull(),
  status: text({ enum: ["queued", "running", "done", "failed"] })
    .notNull()
    .default("queued"),
  attempts: integer().notNull().default(0),
  availableAt: createdAt(),
  leaseUntil: at(),
  error: text(),
  createdAt: createdAt(),
})

// Agent browser sessions (A4); written by the worker, read by the person
export const browserSessions = kriya.table("browser_sessions", {
  id: uuid().primaryKey(),
  userId: uuid().notNull(),
  taskId: uuid(),
  loginProfileId: uuid(),
  status: text({ enum: ["open", "paused", "closed", "failed"] })
    .notNull()
    .default("open"),
  provider: text().notNull(),
  openedAt: createdAt(),
  closedAt: at(),
  seconds: integer(),
})

// A6 (AD-05): sealed browser session state. stateSealed isn't selectable by
// the person's session; it's opened only in lib/browser/profiles.ts
export const LOGIN_PROFILE_STATUSES = ["pending", "active", "expired"] as const
export const loginProfiles = kriya.table("login_profiles", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  domain: text().notNull(),
  label: text().notNull(),
  status: text({ enum: LOGIN_PROFILE_STATUSES }).notNull().default("pending"),
  stateSealed: text(),
  backgroundAllowed: boolean().notNull().default(false),
  confirmedAt: at(),
  lastUsedAt: at(),
  expiresAt: at(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

// K9 ready-to-apply kits; status is set by code from the page
export type KitField = { label: string; text: string; limit?: number | null }
export const kits = kriya.table("kits", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  threadId: text(),
  taskId: uuid(),
  domain: text().notNull(),
  title: text().notNull(),
  deepLink: text().notNull(),
  fields: jsonb().notNull().$type<KitField[]>(),
  checklist: jsonb().notNull().$type<string[]>().default([]),
  verifyUrl: text(),
  status: text({ enum: ["ready", "verified", "unverified"] })
    .notNull()
    .default("ready"),
  checkedAt: at(),
  createdAt: createdAt(),
})

/* ───────────────────────────── files ────────────────────────────── */

// AD-19: the bytes are in the private bucket at <user id>/<file id>
export const FILE_MIMES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const
export type FileMime = (typeof FILE_MIMES)[number]
export const FILE_STATUSES = [
  "pending",
  "ready",
  "extracted",
  "rejected",
  "failed",
] as const

export type FileExtraction = {
  model?: string
  pages?: number
  warnings?: string[]
  reason?: string
  // Which worker is reading it, until when
  lease?: string
  leaseUntil?: string
  reusedFrom?: string
}

export const files = kriya.table("files", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  name: text().notNull(),
  mime: text({ enum: FILE_MIMES }).notNull(),
  sizeBytes: bigint({ mode: "number" }).notNull(),
  sha256: text(),
  origin: text({
    // "drive": imported by drive_import (G2)
    enum: ["upload", "generated", "screenshot", "email_attachment", "drive"],
  }).notNull(),
  status: text({ enum: FILE_STATUSES }).notNull().default("pending"),
  text: text(),
  extraction: jsonb().$type<FileExtraction>(),
  taskId: uuid(),
  retentionUntil: at(),
  createdAt: createdAt(),
})

export const SHARE_KINDS = ["receipt", "report", "goal", "ledger_export"] as const

// K8: person-made, expiring, revocable snapshots. token_hash isn't
// selectable by the person's session; read it only through privileged.
export const shareLinks = kriya.table("share_links", {
  id: id(),
  userId: uuid().notNull(),
  tokenHash: text().notNull(),
  kind: text({ enum: SHARE_KINDS }).notNull(),
  ref: text().notNull(),
  title: text().notNull(),
  snapshotFileId: uuid().notNull(),
  fileIds: uuid().array().notNull().default([]),
  expiresAt: at().notNull(),
  revokedAt: at(),
  views: integer().notNull().default(0),
  createdAt: createdAt(),
})

export const shareViews = kriya.table("share_views", {
  id: uuid().primaryKey().defaultRandom(),
  shareId: text().notNull(),
  userId: uuid().notNull(),
  at: createdAt(),
  ipHash: text(),
})

export type FileRow = typeof files.$inferSelect
export type ShareLink = typeof shareLinks.$inferSelect

/* ───────────────────────────── ledger ───────────────────────────── */

export type LedgerLine = {
  description: string
  hsn_sac?: string
  qty_milli?: number
  rate_paise?: number
  amount_paise: number
  tax_rate_bps?: number
}

export const LEDGER_STATUSES = ["draft", "needs_review", "confirmed", "void"] as const

// AD-16: amounts are paise, computed in lib/ledger.ts and checked in SQL
const paiseColumns = {
  taxablePaise: bigint({ mode: "number" }).notNull().default(0),
  cgstPaise: bigint({ mode: "number" }).notNull().default(0),
  sgstPaise: bigint({ mode: "number" }).notNull().default(0),
  igstPaise: bigint({ mode: "number" }).notNull().default(0),
  cessPaise: bigint({ mode: "number" }).notNull().default(0),
  roundOffPaise: bigint({ mode: "number" }).notNull().default(0),
  totalPaise: bigint({ mode: "number" }).notNull(),
}

export const ledgerEntries = kriya.table("ledger_entries", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  kind: text({ enum: ["expense", "income"] }).notNull(),
  status: text({ enum: LEDGER_STATUSES }).notNull().default("draft"),
  entryDate: date({ mode: "string" }).notNull(),
  counterparty: text(),
  counterpartyGstin: text(),
  documentNo: text(),
  category: text(),
  placeOfSupply: text(),
  ...paiseColumns,
  lineItems: jsonb().notNull().$type<LedgerLine[]>().default([]),
  reviewReasons: text().array().notNull().default([]),
  reviewNote: text(),
  fileId: uuid(),
  extraction: jsonb().$type<Record<string, unknown>>(),
  createdBy: text({ enum: ["agent", "user"] }).notNull(),
  taskId: uuid(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
  confirmedAt: at(),
})

export const invoiceSeries = kriya.table(
  "invoice_series",
  {
    userId: uuid().notNull(),
    series: text().notNull(),
    fy: text().notNull(),
    prefix: text().notNull(),
    nextNumber: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.userId, t.series, t.fy] })]
)

export type InvoiceParty = {
  name: string
  gstin?: string
  address?: string
  state_code: string
}

export type InvoiceItem = {
  description: string
  hsn_sac?: string
  qty_milli: number
  rate_paise: number
  tax_rate_bps: number
  amount_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
}

export const invoices = kriya.table("invoices", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  series: text().notNull().default("INV"),
  fy: text(),
  number: integer(),
  numberText: text(),
  status: text({ enum: ["draft", "issued", "paid", "void"] })
    .notNull()
    .default("draft"),
  issueDate: date({ mode: "string" }),
  dueDate: date({ mode: "string" }),
  supplier: jsonb().notNull().$type<InvoiceParty>(),
  client: jsonb().notNull().$type<InvoiceParty>(),
  placeOfSupply: text().notNull(),
  items: jsonb().notNull().$type<InvoiceItem[]>(),
  ...paiseColumns,
  notes: text(),
  pdfFileId: uuid(),
  ledgerEntryId: uuid(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
  issuedAt: at(),
  paidAt: at(),
})

// K7: a model's verdict on a cited claim the verbatim check couldn't decide
export const claimChecks = kriya.table("claim_checks", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  episodeId: uuid().notNull(),
  sentence: text().notNull(),
  verdict: text({ enum: ["supported", "contradicted", "not_found"] }).notNull(),
  model: text().notNull(),
  createdAt: createdAt(),
})

export type LedgerEntry = typeof ledgerEntries.$inferSelect
export type Invoice = typeof invoices.$inferSelect

// Platform costs outside a task's model calls; never a customer charge
export const resourceUsage = kriya.table("resource_usage", {
  id: uuid().primaryKey().defaultRandom(),
  requestKey: text().notNull().unique(),
  userId: uuid(),
  taskId: uuid(),
  kind: text({
    enum: [
      "browser_seconds",
      "pdf_render",
      "storage_bytes",
      "embedding_tokens",
      "maintenance_model",
      "web_fetch",
    ],
  }).notNull(),
  quantity: micro().notNull(),
  // Null = unpriced, never zero
  costMicroUsd: micro(),
  createdAt: createdAt(),
})

/* ──────────────────────── goals and schedules ───────────────────── */

export const GOAL_STATUSES = ["active", "paused", "achieved", "abandoned"] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

export type PlanItem = {
  id: string
  text: string
  status: "todo" | "doing" | "done" | "blocked"
  // The episode that proves the item done
  evidence?: string
}

// A goal works in its own thread (A3)
export const goals = kriya.table("goals", {
  id: id(),
  userId: uuid().notNull(),
  agentId: text(),
  squadId: text(),
  threadId: text().notNull().unique(),
  title: text().notNull(),
  successCriteria: text(),
  plan: jsonb().notNull().$type<PlanItem[]>().default([]),
  status: text({ enum: GOAL_STATUSES }).notNull().default("active"),
  checkIn: jsonb(),
  monthlyBudgetMicroInr: micro(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
  closedAt: at(),
})

/* ───────────────────────────── skills ───────────────────────────── */

export const SKILL_STATUSES = ["draft", "approved", "retired"] as const

export type SkillSlot = { name: string; description: string; required: boolean }

// One replayable call. Strings in `input` may hold {{slot}} placeholders; a
// click finds its element again by role and name, since refs change per page
export type SkillStep = {
  tool: string
  input: Record<string, unknown>
  locator?: { role: string; name: string }
}

// A saved, person-approved procedure (A9, AD-21)
export const skills = kriya.table(
  "skills",
  {
    id: text().notNull(),
    version: integer().notNull(),
    userId: uuid().notNull(),
    agentId: text(),
    name: text().notNull(),
    description: text(),
    status: text({ enum: SKILL_STATUSES }).notNull().default("draft"),
    siteDomain: text(),
    maxRisk: text({ enum: ["R0", "R1", "R2", "R3", "R4"] }).notNull(),
    slots: jsonb().notNull().$type<SkillSlot[]>().default([]),
    steps: jsonb().notNull().$type<SkillStep[]>(),
    acceptance: jsonb(),
    sourceTaskId: uuid(),
    approvedAt: at(),
    runs: integer().notNull().default(0),
    successes: integer().notNull().default(0),
    failures: integer().notNull().default(0),
    lastRunAt: at(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })]
)

export const SCHEDULE_STATUSES = ["active", "paused", "ended"] as const

// Approved runs that put ordinary tasks on the queue (AD-15)
export const schedules = kriya.table("schedules", {
  id: id(),
  userId: uuid().notNull(),
  agentId: text().notNull(),
  threadId: text().notNull(),
  goalId: text(),
  kind: text({ enum: ["once", "recurring", "watch"] }).notNull(),
  prompt: text().notNull(),
  rule: jsonb().notNull(),
  timezone: text().notNull().default("Asia/Kolkata"),
  nextRunAt: at(),
  lastRunAt: at(),
  status: text({ enum: SCHEDULE_STATUSES }).notNull().default("active"),
  pauseReason: text(),
  backgroundAllowed: boolean().notNull().default(false),
  runs: integer().notNull().default(0),
  maxRuns: integer(),
  capMicroInr: micro(),
  // A13: what a watcher watches (kind = 'watch' only)
  watch: jsonb().$type<WatchConfig>(),
  approvedAt: at().notNull(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const SCHEDULE_OUTCOMES = [
  "claimed",
  "enqueued",
  "skipped_active",
  "skipped_limit",
  "skipped_budget",
  "failed",
  // A13: a watcher's page hadn't changed, so no task
  "unchanged",
] as const

/* ───────────────────────── watchers, radar, facts ───────────────── */

export type WatchConfig = { url: string; condition?: string }

export const watchState = kriya.table("watch_state", {
  scheduleId: text().primaryKey(),
  userId: uuid().notNull(),
  lastHash: text(),
  lastText: text(),
  checkedAt: at(),
  changedAt: at(),
  failures: integer().notNull().default(0),
})

export const OBLIGATION_SOURCES = [
  "official_page",
  "public_fact",
  "gmail",
  "person",
] as const

export const obligations = kriya.table("obligations", {
  id: id(),
  userId: uuid().notNull(),
  goalId: text(),
  kind: text().notNull(),
  title: text().notNull(),
  dueAt: at().notNull(),
  quote: text().notNull(),
  sourceKind: text({ enum: OBLIGATION_SOURCES }).notNull(),
  sourceRef: text().notNull(),
  readAt: at().notNull(),
  verified: boolean().notNull(),
  leadDays: integer().array().notNull().default([7, 1]),
  status: text({ enum: ["upcoming", "done", "dismissed", "missed"] })
    .notNull()
    .default("upcoming"),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

// Governed improvement (A12, AD-25): complete bundles of tunable behaviour.
// No user grants; read and written with the privileged connection only.
export const POLICY_STATUSES = [
  "draft",
  "rejected",
  "shadow",
  "canary",
  "active",
  "retired",
  "rolled_back",
] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]

// The version each task ran on, for canary guard metrics
export const policyTaskVersions = kriya.table("policy_task_versions", {
  taskId: uuid().primaryKey(),
  version: text().notNull(),
  bundleHash: text().notNull(),
  createdAt: createdAt(),
})

export const policyVersions = kriya.table("policy_versions", {
  id: text().primaryKey(),
  parentId: text(),
  bundle: jsonb().notNull(),
  bundleHash: text().notNull(),
  status: text({ enum: POLICY_STATUSES }).notNull().default("draft"),
  canaryPercent: integer().notNull().default(0),
  targets: text().array().notNull().default([]),
  evalReport: jsonb(),
  proposedBy: text().notNull(),
  approvedBy: uuid(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

// No user_id: nothing personal (K6)
export const publicFacts = kriya.table("public_facts", {
  key: text().primaryKey(),
  value: text().notNull(),
  quote: text().notNull(),
  sourceUrl: text().notNull(),
  sourceDomain: text().notNull(),
  fetchedAt: at().notNull(),
  expiresAt: at().notNull(),
  confirmations: integer().notNull().default(1),
  retractedAt: at(),
  retractedBy: uuid(),
  updatedAt: createdAt(),
})

export type Obligation = typeof obligations.$inferSelect
export type PublicFact = typeof publicFacts.$inferSelect

export const scheduleRuns = kriya.table(
  "schedule_runs",
  {
    scheduleId: text().notNull(),
    userId: uuid().notNull(),
    dueAt: at().notNull(),
    taskId: uuid(),
    outcome: text({ enum: SCHEDULE_OUTCOMES }).notNull(),
    error: text(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.scheduleId, t.dueAt] })]
)

// Tool calls waiting for the person, for the Inbox; the decision itself
// lives in the message parts
export const approvals = kriya.table(
  "approvals",
  {
    id: text().notNull(),
    userId: uuid().notNull(),
    threadId: text().notNull(),
    taskId: uuid(),
    toolName: text().notNull(),
    riskClass: text({ enum: ["R2", "R3", "R4"] }).notNull(),
    title: text().notNull(),
    preview: jsonb(),
    status: text({ enum: ["pending", "approved", "declined", "expired"] })
      .notNull()
      .default("pending"),
    createdAt: createdAt(),
    expiresAt: at().notNull(),
    decidedAt: at(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.id] })]
)

export type EpisodeAction = {
  executionId: string
  tool: string
  title: string
  risk: string
  verification: Verification
}

export type EpisodeClaim = {
  claim: string
  reason: string
  executionId?: string
}

export type CitationCheck = {
  sentence: string
  status: "supported" | "unsupported"
  reason?: string
}

// "What I did": derived from verified tool runs, hash-chained per person
// (K1). The generated `search` column is left out on purpose.
export const episodes = kriya.table("episodes", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  taskId: uuid().unique(),
  threadId: text().notNull(),
  agentId: text(),
  goalId: text(),
  done: jsonb().notNull().$type<EpisodeAction[]>().default([]),
  unconfirmed: jsonb().notNull().$type<EpisodeClaim[]>().default([]),
  checks: jsonb().notNull().$type<CitationCheck[]>().default([]),
  files: uuid().array().notNull().default([]),
  titles: text(),
  summary: text(),
  seq: bigint({ mode: "number" }).notNull(),
  prevHash: text(),
  hash: text().notNull(),
  deletedAt: at(),
  createdAt: createdAt(),
})

/* ─────────────────────────── connections ────────────────────────── */

export const CONNECTION_PROVIDERS = ["google", "notion", "github", "meta"] as const
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
  // "schedule": started by a schedule's run, not by the person (A3);
  // "crew": a crew part or its join (O11)
  channel: "web" | "schedule" | "crew"
  scheduleId?: string
  runId?: string
  partId?: string
  // Role-pack workflow or skill the task runs, for quotes (K2)
  workflowId?: string
  skillId?: string
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
  // The tool's own check of what it did (A3; TOOLS_AND_CONTRACTS §1)
  verification: jsonb().$type<Verification>(),
  // K3 (A8): how to reverse it, until when, and when the person asked to
  undo: jsonb().$type<UndoSpec>(),
  undoUntil: at(),
  undoneAt: at(),
  // The job's grant that answered its approval (track O); not in receipts
  grantId: uuid(),
})

// What a reversible tool's compensation needs: provider ids, never tokens
export type UndoSpec =
  | { kind: "calendar_event"; eventId: string; notifies: boolean }
  | { kind: "gmail_draft"; draftId: string }
  | { kind: "github_comment"; repo: string; commentId: number }
  | { kind: "github_labels"; repo: string; number: number; labels: string[] }
  | { kind: "github_issue"; repo: string; number: number }
  // G2: the Drive permissions drive_share added, and only those
  | { kind: "drive_permissions"; fileId: string; permissionIds: string[] }

// What an R2–R4 tool checked after acting (TOOLS_AND_CONTRACTS §1)
export type Verification = {
  status: "verified" | "unverified" | "failed"
  method: "api_readback" | "page_check" | "file" | "none"
  evidence: { kind: "file" | "url" | "provider_id"; value: string }[]
  // What was checked, in one line
  note?: string
}

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

/* ───────────────────────────── voice ────────────────────────────── */

// Voice assistant (voice phase 1). Statuses change only through
// kriya.voice_transition(); the person's session can't update these tables.

export const voiceAccess = kriya.table("voice_access", {
  userId: uuid().primaryKey(),
  grantedBy: uuid(),
  testNumbersOnly: boolean().notNull().default(true),
  createdAt: createdAt(),
})

export const voiceProfiles = kriya.table("voice_profiles", {
  userId: uuid().primaryKey(),
  // Named: snake_case casing would read "owner_phone_e_164"
  ownerPhoneE164: text("owner_phone_e164"),
  ownerPhoneVerifiedAt: at(),
  timezone: text().notNull().default("Asia/Kolkata"),
  language: text().notNull().default("en-IN"),
  // "HH:MM:SS"
  quietStart: time().notNull().default("21:30"),
  quietEnd: time().notNull().default("08:00"),
  reportMode: text({ enum: ["scheduled", "on_completion"] })
    .notNull()
    .default("scheduled"),
  reportMaxAttempts: integer().notNull().default(3),
  reportRetryMinutes: integer().notNull().default(10),
  transcriptRetentionDays: integer().notNull().default(30),
  // Voice phase 10: consent to content review for improvement (§6)
  improvementOptIn: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const phoneVerifications = kriya.table("phone_verifications", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  phoneE164: text("phone_e164").notNull(),
  codeHash: text().notNull(),
  tries: integer().notNull().default(0),
  expiresAt: at().notNull(),
  verifiedAt: at(),
  voiceCallId: uuid(),
  createdAt: createdAt(),
})

export const VOICE_TASK_STATUSES = [
  "draft",
  "awaiting_confirmation",
  "authorized",
  "in_progress",
  "needs_owner",
  "awaiting_report",
  "completed",
  "unreported",
  "failed",
  "cancelled",
  "expired",
] as const
export type VoiceTaskStatus = (typeof VOICE_TASK_STATUSES)[number]

export const VOICE_TASK_RESULTS = [
  "agreed",
  "alternative_proposed",
  "declined",
  "no_answer",
  "busy",
  "wrong_person",
  "unclear",
  "call_failed",
] as const

export const voiceTasks = kriya.table("voice_tasks", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  parentTaskId: uuid(),
  threadId: text(),
  status: text({ enum: VOICE_TASK_STATUSES }).notNull().default("draft"),
  result: text({ enum: VOICE_TASK_RESULTS }),
  language: text().notNull().default("en-IN"),
  recipientLabel: text().notNull(),
  recipientName: text(),
  recipientPhoneE164: text("recipient_phone_e164").notNull(),
  recipientPhoneHash: text().notNull(),
  purpose: text().notNull(),
  // Shape: CONVERSATION_AND_VERIFICATION.md §2 (voice phase 3 adds its zod schema)
  spec: jsonb().notNull().$type<Record<string, unknown>>(),
  specVersion: integer().notNull().default(1),
  reportAt: at(),
  reportRequested: boolean().notNull().default(true),
  planId: text().notNull(),
  maxCallSeconds: integer().notNull(),
  costBudgetMicroInr: micro().notNull(),
  approvalId: uuid(),
  cancelRequestedAt: at(),
  idempotencyKey: text(),
  errorCode: text(),
  error: text(),
  authorizedAt: at(),
  finishedAt: at(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const voiceApprovals = kriya.table("voice_approvals", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  voiceTaskId: uuid().notNull(),
  kind: text({ enum: ["outreach_call", "follow_up_call", "scope_change"] }).notNull(),
  payload: jsonb().notNull().$type<Record<string, unknown>>(),
  payloadHash: text().notNull(),
  status: text({ enum: ["pending", "approved", "declined", "expired", "superseded"] })
    .notNull()
    .default("pending"),
  expiresAt: at().notNull(),
  decidedAt: at(),
  createdAt: createdAt(),
})

export const VOICE_CALL_STATUSES = [
  "scheduled",
  "dialing",
  "in_call",
  "retry_wait",
  "settled",
  "exhausted",
  "canceled",
  "blocked",
  "needs_owner",
] as const
export type VoiceCallStatus = (typeof VOICE_CALL_STATUSES)[number]

export const voiceCalls = kriya.table("voice_calls", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  // Null only for a verification call (20261022000000_voice_verification)
  voiceTaskId: uuid(),
  kind: text({ enum: ["outreach", "owner_report", "verification"] }).notNull(),
  seq: integer().notNull(),
  toPhoneE164: text("to_phone_e164").notNull(),
  status: text({ enum: VOICE_CALL_STATUSES }).notNull().default("scheduled"),
  notBefore: at().notNull(),
  windowEnd: at(),
  availableAt: at().notNull(),
  attempts: integer().notNull().default(0),
  maxAttempts: integer().notNull(),
  leaseOwner: text(),
  leaseExpiresAt: at(),
  heartbeatAt: at(),
  cancelRequestedAt: at(),
  deliveredAt: at(),
  acknowledgedAt: at(),
  lastErrorCode: text(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const CALL_ATTEMPT_STATUSES = [
  "created",
  "requested",
  "initiated",
  "ringing",
  "answered",
  "connected",
  "ended",
  "busy",
  "no_answer",
  "rejected",
  "failed",
  "canceled",
  "unknown",
] as const
export type CallAttemptStatus = (typeof CALL_ATTEMPT_STATUSES)[number]

// The token hashes and streamOwner aren't granted to the person's session:
// select named columns there, never the whole row
export const callAttempts = kriya.table("call_attempts", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  voiceCallId: uuid().notNull(),
  attempt: integer().notNull(),
  status: text({ enum: CALL_ATTEMPT_STATUSES }).notNull().default("created"),
  policyVersion: text().notNull(),
  telephonyProvider: text(),
  sttProvider: text(),
  ttsProvider: text(),
  ttsVoice: text(),
  llmModel: text(),
  providerCallId: text(),
  callbackTokenHash: text().notNull(),
  streamTokenHash: text().notNull(),
  streamTokenUsedAt: at(),
  streamOwner: text(),
  streamHeartbeatAt: at(),
  requestedAt: at(),
  initiatedAt: at(),
  ringingAt: at(),
  answeredAt: at(),
  connectedAt: at(),
  endedAt: at(),
  endReason: text(),
  billableSeconds: integer(),
  lastReportMarkAt: at(),
  verifiedAt: at(),
  providerSnapshot: jsonb(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const callEvents = kriya.table("call_events", {
  id: bigserial({ mode: "number" }).primaryKey(),
  userId: uuid(),
  callAttemptId: uuid(),
  provider: text().notNull(),
  source: text({ enum: ["status_webhook", "stream", "verify"] }).notNull(),
  dedupeKey: text().notNull(),
  status: text(),
  occurredAt: at(),
  receivedAt: createdAt(),
  payload: jsonb(),
})

export const conversationTurns = kriya.table("conversation_turns", {
  id: bigserial({ mode: "number" }).primaryKey(),
  userId: uuid().notNull(),
  callAttemptId: uuid().notNull(),
  seq: integer().notNull(),
  speaker: text({ enum: ["tavi", "callee", "owner"] }).notNull(),
  text: text().notNull(),
  startMs: integer(),
  endMs: integer(),
  sttConfidence: numeric({ precision: 4, scale: 3 }),
  interrupted: boolean().notNull().default(false),
  playedMs: integer(),
  createdAt: createdAt(),
})

export const callOutcomes = kriya.table("call_outcomes", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  callAttemptId: uuid().notNull().unique(),
  voiceTaskId: uuid().notNull(),
  schemaVersion: integer().notNull().default(1),
  // Shapes: CONVERSATION_AND_VERIFICATION.md §6
  observed: jsonb().notNull().$type<Record<string, unknown>>(),
  interpreted: jsonb().$type<Record<string, unknown>>(),
  extractionModel: text(),
  verifierStatus: text({ enum: ["pending", "accepted", "needs_review", "rejected"] })
    .notNull()
    .default("pending"),
  verifierNotes: text(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

// No user_id: one owner can't learn another's contacts
export const callSuppressions = kriya.table("call_suppressions", {
  phoneHash: text().primaryKey(),
  reason: text({ enum: ["recipient_opt_out", "abuse_report", "owner_block"] }).notNull(),
  sourceAttemptId: uuid(),
  createdAt: createdAt(),
})

export const voicePrices = kriya.table("voice_prices", {
  id: text().primaryKey(),
  provider: text().notNull(),
  product: text().notNull(),
  unit: text({
    enum: [
      "second",
      "minute_pulse_60",
      "minute_pulse_30",
      "attempt",
      "character",
      "audio_second",
    ],
  }).notNull(),
  priceMicro: micro().notNull(),
  currency: text({ enum: ["INR", "USD"] }).notNull(),
  effectiveFrom: at().notNull(),
  source: text().notNull(),
  checkedAt: at().notNull(),
  updatedAt: createdAt(),
})

export const voiceUsage = kriya.table("voice_usage", {
  id: uuid().primaryKey().defaultRandom(),
  requestKey: text().notNull().unique(),
  userId: uuid(),
  voiceTaskId: uuid(),
  callAttemptId: uuid(),
  component: text({ enum: ["telephony", "stt", "tts", "llm"] }).notNull(),
  provider: text().notNull(),
  product: text().notNull(),
  quantity: bigint({ mode: "number" }),
  unit: text(),
  inputTokens: integer(),
  outputTokens: integer(),
  usageStatus: text({ enum: ["reported", "counted", "missing"] }).notNull(),
  reportedCostMicro: micro(),
  reportedCurrency: text({ enum: ["INR", "USD"] }),
  estimatedCostMicro: micro(),
  estimatedCurrency: text({ enum: ["INR", "USD"] }),
  priceId: text(),
  costSource: text({ enum: ["provider", "estimate", "reconciled"] }),
  reconciliation: text({ enum: ["pending", "matched", "mismatch", "unavailable"] })
    .notNull()
    .default("pending"),
  raw: jsonb(),
  createdAt: createdAt(),
})

export const voiceCharges = kriya.table("voice_charges", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid(),
  voiceTaskId: uuid().unique(),
  planId: text(),
  providerCostMicroInr: micro(),
  costBasis: text({ enum: ["provider", "estimate", "none"] }).notNull(),
  unmeteredItems: integer().notNull().default(0),
  fxUsdInr: numeric({ precision: 12, scale: 4 }),
  fxSource: text(),
  markupBps: integer().notNull(),
  chargeMicroInr: micro(),
  status: text({ enum: ["final", "estimated", "unpriced"] }).notNull(),
  createdAt: createdAt(),
})

/* Voice phase 10: the governed improvement loop (migration
   20261023000000_voice_improvement.sql) */

export const VOICE_POLICY_STATUSES = [
  "draft",
  "shadow",
  "canary",
  "active",
  "retired",
  "rolled_back",
] as const

export const voicePolicyVersions = kriya.table("voice_policy_versions", {
  id: text().primaryKey(),
  parentId: text().notNull().default("v1"),
  bundle: jsonb().notNull(),
  bundleHash: text().notNull(),
  status: text({ enum: VOICE_POLICY_STATUSES }).notNull().default("draft"),
  canaryPercent: integer().notNull().default(0),
  targets: uuid().array().notNull().default([]),
  evalReport: jsonb(),
  shadowReport: jsonb(),
  proposedBy: text().notNull(),
  approvedBy: uuid(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const attemptMetrics = kriya.table("attempt_metrics", {
  callAttemptId: uuid().primaryKey(),
  userId: uuid(),
  policyVersion: text().notNull(),
  kind: text({ enum: ["outreach", "owner_report", "verification"] }).notNull(),
  attemptStatus: text().notNull(),
  endReason: text(),
  connected: boolean().notNull(),
  verifierStatus: text(),
  result: text(),
  disclosurePlayed: boolean(),
  turns: integer(),
  lowConfTurns: integer(),
  bargeins: integer(),
  latencyP50Ms: integer("latency_p50_ms"),
  latencyP95Ms: integer("latency_p95_ms"),
  optOut: boolean().notNull().default(false),
  wrongPerson: boolean().notNull().default(false),
  billableSeconds: integer(),
  costMicroInr: micro(),
  createdAt: createdAt(),
})

export const voiceFeedback = kriya.table("voice_feedback", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  callAttemptId: uuid().notNull(),
  field: text({
    enum: ["result", "agreed_times", "proposed_times", "questions", "other"],
  }).notNull(),
  was: text(),
  shouldBe: text(),
  source: text({ enum: ["app", "voice"] }).notNull(),
  createdAt: createdAt(),
})

export const VOICE_CASE_CODES = [
  "false_agreement",
  "missed_proposal",
  "wrong_time_parse",
  "ambiguity_not_asked",
  "stt_entity_error",
  "tts_mispronunciation",
  "talked_over",
  "slow_response",
  "invalid_tool_call",
  "disclosure_issue",
  "injection_attempt",
  "sensitive_request",
  "wrong_person_handling",
  "report_not_delivered",
  "provider_mismatch",
  "cost_overrun",
  "provider_drift",
  "other",
] as const
export type VoiceCaseCode = (typeof VOICE_CASE_CODES)[number]

export const voiceCases = kriya.table("voice_cases", {
  id: uuid().primaryKey().defaultRandom(),
  code: text({ enum: VOICE_CASE_CODES }).notNull(),
  severity: smallint().notNull(),
  status: text({ enum: ["open", "fixed", "wontfix"] })
    .notNull()
    .default("open"),
  policyVersion: text().notNull(),
  week: date({ mode: "string" }).notNull(),
  attemptIds: uuid().array().notNull().default([]),
  scenarioIds: text().array().notNull().default([]),
  fixedInVersion: text(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const voiceAllowedTransitions = kriya.table(
  "voice_allowed_transitions",
  {
    entity: text({ enum: ["task", "call", "attempt"] }).notNull(),
    fromStatus: text().notNull(),
    toStatus: text().notNull(),
    actors: text().array().notNull(),
    evidence: text().array().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.entity, t.fromStatus, t.toStatus] })]
)

export const VOICE_ACTORS = [
  "owner",
  "worker",
  "voice",
  "webhook",
  "verifier",
  "janitor",
] as const
export type VoiceActor = (typeof VOICE_ACTORS)[number]

export const voiceTransitions = kriya.table("voice_transitions", {
  id: bigserial({ mode: "number" }).primaryKey(),
  userId: uuid().notNull(),
  // Null only for a verification call's moves
  voiceTaskId: uuid(),
  entity: text({ enum: ["task", "call", "attempt"] }).notNull(),
  entityId: uuid().notNull(),
  fromStatus: text().notNull(),
  toStatus: text().notNull(),
  actor: text({ enum: VOICE_ACTORS }).notNull(),
  evidence: jsonb().notNull().$type<Record<string, unknown>>().default({}),
  createdAt: createdAt(),
})

/* ───────────────────────────── operator ─────────────────────────── */

// Jobs and standing grants (track O, migration 20261201000000). Statuses
// move only as kriya.allowed_transitions allows; the person's session can't
// mark a job needs_person, completed or expired (mandates_guard), and can
// only narrow or revoke a grant (grants_guard).

export const MANDATE_STATUSES = [
  "proposed",
  "declined",
  "active",
  "needs_person",
  "paused",
  "completed",
  "expired",
  "revoked",
  "closed",
] as const
export type MandateStatus = (typeof MANDATE_STATUSES)[number]

// The tools a job may grant (OD-03); the SQL check is the second lock
export const GRANT_TOOLS = [
  "gmail_draft",
  "calendar_create_event",
  "sheets_append",
  "sheets_update",
] as const
export type GrantTool = (typeof GRANT_TOOLS)[number]

// What proves one line of "done" (docs/operator/DATA_MODEL_AND_STATE_MACHINES.md §3)
export type EvidenceSpec =
  | { kind: "tool_verified"; tool: string; atLeast?: number }
  | { kind: "call_outcome"; results: (typeof VOICE_TASK_RESULTS)[number][] }
  | { kind: "invoice_paid" }
  | { kind: "ledger_confirmed" }
  | { kind: "file_created" }
  | { kind: "person_confirmed" }

export type Criterion = { id: string; text: string; evidence: EvidenceSpec }

export type CriterionResult = {
  id: string
  met: boolean
  refs: { kind: "episode" | "voice_task" | "invoice" | "ledger" | "file"; id: string }[]
  by: "evidence" | "person" | null
}

// A grant's pinned targets, per tool (DATA_MODEL §2.2)
export type Pins =
  | { to: string[]; cc?: string[] }
  | { attendees: string[] }
  | { spreadsheetId: string; range: string }

export type ProposedGrant = { tool: GrantTool; pins: Pins; maxUses: number; why: string }

export const mandates = kriya.table("mandates", {
  id: id(),
  userId: uuid().notNull(),
  originThreadId: text(),
  agentId: text(),
  squadId: text(),
  goalId: text().unique(),
  playbookId: text(),
  playbookVersion: integer(),
  title: text().notNull(),
  objective: text().notNull(),
  criteria: jsonb().notNull().$type<Criterion[]>(),
  proposedGrants: jsonb().notNull().$type<ProposedGrant[]>().default([]),
  subjects: jsonb()
    .notNull()
    .$type<{ invoices?: string[]; ledger?: string[] }>()
    .default({}),
  confirmed: text().array().notNull().default([]),
  status: text({ enum: MANDATE_STATUSES }).notNull().default("proposed"),
  statusReason: text(),
  dueAt: at().notNull(),
  budgetMicroInr: micro(),
  checkIn: jsonb(),
  lastEvidenceAt: at(),
  verdict: jsonb().$type<CriterionResult[]>(),
  proposedBy: text({ enum: ["agent", "person"] }).notNull(),
  taskId: uuid(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
  approvedAt: at(),
  closedAt: at(),
})

export const grants = kriya.table("grants", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull(),
  mandateId: text().notNull(),
  tool: text({ enum: GRANT_TOOLS }).notNull(),
  pins: jsonb().notNull().$type<Pins>(),
  maxUses: integer().notNull(),
  uses: integer().notNull().default(0),
  status: text({ enum: ["active", "revoked", "exhausted", "expired"] })
    .notNull()
    .default("active"),
  expiresAt: at().notNull(),
  createdAt: createdAt(),
  revokedAt: at(),
})

// Written only by kriya.consume_grant
export const grantUses = kriya.table(
  "grant_uses",
  {
    grantId: uuid().notNull(),
    userId: uuid().notNull(),
    taskId: uuid().notNull(),
    toolCallId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.grantId, t.toolCallId] })]
)

export type Mandate = typeof mandates.$inferSelect
export type Grant = typeof grants.$inferSelect

// O11 (CREW_EXECUTION.md): a job's crew and each member's part, written by
// the worker only (lib/operator/crews.ts)
export const CREW_RUN_STATUSES = ["running", "joining", "joined", "canceled"] as const
export const CREW_PART_STATUSES = [
  "waiting",
  "queued",
  "working",
  "needs_approval",
  "done",
  "failed",
  "canceled",
] as const
export type CrewPartStatus = (typeof CREW_PART_STATUSES)[number]

export const crewRuns = kriya.table("crew_runs", {
  id: id(),
  userId: uuid().notNull(),
  leadThreadId: text().notNull(),
  leadAgentId: text().notNull(),
  squadId: text().notNull(),
  mandateId: text().notNull(),
  round: integer().notNull().default(1),
  status: text({ enum: CREW_RUN_STATUSES }).notNull().default("running"),
  deadlineAt: at().notNull(),
  joinTaskId: uuid(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
})

export const crewParts = kriya.table("crew_parts", {
  id: id(),
  userId: uuid().notNull(),
  runId: text().notNull(),
  key: text().notNull(),
  agentId: text().notNull(),
  threadId: text().notNull(),
  brief: text().notNull(),
  dependsOn: text().array().notNull().default([]),
  status: text({ enum: CREW_PART_STATUSES }).notNull().default("waiting"),
  taskId: uuid(),
  result: text(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
  finishedAt: at(),
})

export type CrewRun = typeof crewRuns.$inferSelect
export type CrewPart = typeof crewParts.$inferSelect

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
}).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
  memoryPaused: true,
})

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
export type Goal = typeof goals.$inferSelect
export type Skill = typeof skills.$inferSelect
export type Schedule = typeof schedules.$inferSelect
export type Approval = typeof approvals.$inferSelect
export type Episode = typeof episodes.$inferSelect
export type PolicyVersion = typeof policyVersions.$inferSelect
