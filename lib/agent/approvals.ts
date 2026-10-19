import { and, eq, lt, sql } from "drizzle-orm"

import { privileged } from "@/db"
import { approvals, type Approval } from "@/db/schema"
import { loadMessages, saveMessage } from "@/lib/agent/messages"
import { classifyTool } from "@/lib/agent/policy"
import type { KriyaMessage } from "@/lib/agent/tools"
import { getSetting } from "@/lib/config"
import { describeRule, ruleSchema, scheduleFacts } from "@/lib/schedules"

// The Inbox's index of tool calls waiting for the person (A3, AD-15). The
// decision itself still lives in the message parts and goes through
// enqueueApproval; these rows let the Inbox list them, and let an unanswered
// one expire as declined without starting a task (AF-14).

// Tool inputs are kept as evidence, minus anything that looks like a secret
export function redactInput(input: unknown) {
  const text = JSON.stringify(input ?? null)
  if (text.length > 4_000) return { truncated: text.slice(0, 4_000) }
  return JSON.parse(
    text.replace(
      /("(?:password|token|secret|otp|cvv|card)[^"]*"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"'
    )
  )
}

type Input = Record<string, unknown> | null | undefined
const quoted = (value: unknown) => `"${String(value ?? "").slice(0, 80)}"`
const cadence = (rule: unknown) => {
  const parsed = ruleSchema.safeParse(rule)
  return parsed.success ? describeRule(parsed.data) : "a new time"
}

// One line for the Inbox ("ask") and for "What I did" ("done")
export function actionTitle(tool: string, input: Input, tense: "ask" | "done") {
  const ask = tense === "ask"
  switch (tool) {
    case "calendar_create_event":
      return `${ask ? "Add" : "Added"} ${quoted(input?.title)} to your calendar`
    case "gmail_draft":
      return `${ask ? "Save" : "Saved"} a draft email: ${quoted(input?.subject)}`
    case "schedule_create":
      return `${ask ? "Start" : "Started"} a schedule: ${cadence(input?.rule)}`
    case "schedule_update":
      return input?.rule
        ? `${ask ? "Change" : "Changed"} a schedule to ${cadence(input.rule)}`
        : `${ask ? "Update" : "Updated"} a schedule`
    case "goal_create":
      return `${ask ? "Start" : "Started"} the goal ${quoted(input?.title)}`
    // A8 connectors
    case "github_comment":
      return `${ask ? "Comment" : "Commented"} on ${String(input?.repo ?? "")}#${String(input?.number ?? "")}`
    case "github_create_issue":
      return `${ask ? "Open" : "Opened"} the issue ${quoted(input?.title)} in ${String(input?.repo ?? "")}`
    case "github_label":
      return `${ask ? "Label" : "Labelled"} ${String(input?.repo ?? "")}#${String(input?.number ?? "")}`
    case "github_open_pr":
      return `${ask ? "Open" : "Opened"} the pull request ${quoted(input?.title)} in ${String(input?.repo ?? "")}`
    case "sheets_append":
      return `${ask ? "Add" : "Added"} rows to a Google Sheet`
    case "sheets_update":
      return `${ask ? "Update" : "Updated"} ${quoted(input?.range)} in a Google Sheet`
    case "instagram_publish":
      return `${ask ? "Post" : "Posted"} on Instagram: ${quoted(input?.caption)}`
    default:
      return tool.replaceAll("_", " ")
  }
}

type Part = {
  type: string
  state?: string
  input?: unknown
  approval?: { id?: string }
}

// A reply that ended waiting: one row per approval it asks for
export async function recordApprovals(task: {
  id: string
  userId: string
  threadId: string
  reply: KriyaMessage
}) {
  const hours = Number.parseInt((await getSetting("agents.approvalTtlHours")) ?? "", 10)
  const ttl = (Number.isFinite(hours) && hours > 0 ? hours : 72) * 3_600_000
  const rows = (task.reply.parts as Part[])
    .filter((p) => p.state === "approval-requested" && p.approval?.id)
    .map((p) => {
      const tool = p.type.replace(/^tool-/, "")
      const input = (p.input ?? null) as Input
      const risk = classifyTool(tool, input)
      const rule = ruleSchema.safeParse(input?.rule)
      return {
        id: p.approval!.id!,
        userId: task.userId,
        threadId: task.threadId,
        taskId: task.id,
        toolName: tool,
        // Anything outside R2–R3 that still asked is shown as the most serious
        riskClass: (["R2", "R3", "R4"].includes(risk)
          ? risk
          : "R4") as Approval["riskClass"],
        title: actionTitle(tool, input, "ask").slice(0, 200),
        preview: {
          input: redactInput(input),
          ...(tool.startsWith("schedule_") && rule.success && scheduleFacts(rule.data)),
        },
        expiresAt: new Date(Date.now() + ttl),
      }
    })
  if (rows.length > 0)
    await privileged.insert(approvals).values(rows).onConflictDoNothing()
  return rows.length
}

// Approvals nobody answered in time count as declined. Per thread, in one
// transaction: the row expires and the waiting part in the reply is
// answered "Expired". No task starts; the next turn tells the model.
export async function expireApprovals() {
  const due = await privileged
    .selectDistinct({ userId: approvals.userId, threadId: approvals.threadId })
    .from(approvals)
    .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, sql`now()`)))
    .limit(100)
  let expired = 0
  for (const { userId, threadId } of due) {
    await privileged.transaction(async (tx) => {
      const rows = await tx
        .update(approvals)
        .set({ status: "expired", decidedAt: new Date() })
        .where(
          and(
            eq(approvals.threadId, threadId),
            eq(approvals.userId, userId),
            eq(approvals.status, "pending"),
            lt(approvals.expiresAt, sql`now()`)
          )
        )
        .returning({ id: approvals.id })
      const ids = new Set(rows.map((row) => row.id))
      expired += ids.size
      const last = (await loadMessages(tx, threadId)).at(-1)
      if (!last || last.role !== "assistant") return
      let changed = false
      const parts = (last.parts as Part[]).map((part) => {
        if (part.state !== "approval-requested" || !ids.has(part.approval?.id ?? ""))
          return part
        changed = true
        return {
          ...part,
          state: "approval-responded",
          approval: { ...part.approval, approved: false, reason: "Expired" },
        }
      })
      if (changed) {
        await saveMessage(tx, userId, threadId, {
          ...last,
          parts: parts as KriyaMessage["parts"],
        })
      }
    })
  }
  return expired
}
