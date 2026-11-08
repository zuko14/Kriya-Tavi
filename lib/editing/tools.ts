import { randomUUID } from "node:crypto"

import { tool } from "ai"
import { and, desc, eq, isNull } from "drizzle-orm"
import { z } from "zod"

import { withUser } from "@/db"
import {
  editDeliverables,
  editJobs,
  harnessDevices,
  harnessDeviceState as state,
} from "@/db/schema"
import { FOREIGN, type ToolEnv } from "@/lib/agent/tools"
import { DaemonProject } from "@/lib/harness/contract"
import { ONLINE_MS, queueEdit } from "@/lib/harness/control"

// The video_edit_* tools (TOOLS_AND_CONTRACTS §7), on the belt only with
// editing.tavi on. They run in kriya-worker as the person. Starting one is R3: the
// person approves the exact call, and then their computer does the work, in a
// folder it offers. No tool lists files, reads footage, cancels, or sets a status.
// A refused start throws, as a connector does, so "What I did" records a failure and
// never a call that ran (track-A rule 7).

const brief = z.string().trim().min(1).max(4000)

export function createEditTools(env: ToolEnv) {
  return {
    video_edit_places: tool({
      description:
        "List the person's computers that are online and allow editing from Kriya, with the folders each offers. Call this first: a folder must come from here, never from a path anyone typed. It lists no files.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await withUser(env.userId, (tx) =>
          tx
            .select({
              device: harnessDevices.id,
              name: harnessDevices.name,
              capabilities: state.capabilities,
              projects: state.projects,
              polledAt: state.polledAt,
            })
            .from(harnessDevices)
            .innerJoin(state, eq(state.deviceId, harnessDevices.id))
            .where(isNull(harnessDevices.revokedAt))
        )
        const computers = rows
          .filter(
            (r) =>
              r.polledAt &&
              Date.now() - r.polledAt.getTime() <= ONLINE_MS &&
              (r.capabilities as { edit?: boolean } | null)?.edit === true
          )
          .map((r) => ({
            device: r.device,
            name: r.name,
            folders: (r.projects ?? []).flatMap((p) => {
              const ok = DaemonProject.safeParse(p)
              return ok.success ? [{ project: ok.data.id, name: ok.data.name }] : []
            }),
          }))
        return computers.length
          ? { notice: FOREIGN, computers }
          : {
              computers,
              note: "No computer is ready. On one, turn on Remote Control and Allow editing from Kriya, or run kriya daemon --allow-edit.",
            }
      },
    }),

    video_edit_start: tool({
      description:
        "Start one edit on the person's computer: their footage stays there, and only a small preview comes back. Say in the brief which recording, in words, and what they want. The person approves this exact call. When it finishes, a card appears in this thread by itself, so don't wait for it or check repeatedly.",
      inputSchema: z.object({
        device: z.uuid().describe("A computer from video_edit_places"),
        project: z
          .string()
          .regex(/^[a-f0-9]{16}$/)
          .describe("A folder id from video_edit_places"),
        // What the person reads on the approval card; refused unless it's the truth
        computer: z
          .string()
          .min(1)
          .max(200)
          .describe("That computer's name, exactly as video_edit_places gave it"),
        folder: z
          .string()
          .min(1)
          .max(80)
          .describe("That folder's name, exactly as video_edit_places gave it"),
        brief,
        recipe: z
          .string()
          .regex(/^[a-z0-9-]{1,48}$/)
          .optional(),
        effort: z.enum(["fast", "best"]).default("best"),
      }),
      execute: async ({ device, project, computer, folder, brief, recipe, effort }) => {
        // queueEdit refuses a computer or folder that isn't there; here the names
        const [place] = await withUser(env.userId, (tx) =>
          tx
            .select({ name: harnessDevices.name, projects: state.projects })
            .from(harnessDevices)
            .leftJoin(state, eq(state.deviceId, harnessDevices.id))
            .where(eq(harnessDevices.id, device))
        )
        const offered = (place?.projects ?? []).find(
          (p) => DaemonProject.safeParse(p).data?.id === project
        ) as { name?: string } | undefined
        if ((place && place.name !== computer) || (offered && offered.name !== folder))
          throw new Error(
            "That name isn't what this computer reports. Check video_edit_places again."
          )
        const job = randomUUID()
        await queueEdit(
          env.userId,
          device,
          { project, job, brief, effort, ...(recipe && { recipe }) },
          { threadId: env.threadId }
        )
        return { job, status: "queued" }
      },
    }),

    video_edit_status: tool({
      description:
        "How one edit is going. A verdict here is reported by the person's computer, not proven by Kriya; say so. A preview link is a file Kriya has checked.",
      inputSchema: z.object({ job: z.uuid() }),
      execute: async ({ job }) => {
        const [row] = await withUser(env.userId, (tx) =>
          tx.select().from(editJobs).where(eq(editJobs.id, job))
        )
        if (!row) return { error: "That edit isn't there." }
        const [preview] = await withUser(env.userId, (tx) =>
          tx
            .select({ id: editDeliverables.id })
            .from(editDeliverables)
            .where(
              and(
                eq(editDeliverables.jobId, job),
                eq(editDeliverables.kind, "preview"),
                eq(editDeliverables.status, "ready"),
                isNull(editDeliverables.deletedAt)
              )
            )
            .orderBy(desc(editDeliverables.createdAt))
            .limit(1)
        )
        return {
          job: row.id,
          status: row.status,
          stage: row.stage,
          percent: row.percent,
          reportedByComputer: row.verdict,
          ...(preview && { preview: `/api/editing/preview/${preview.id}` }),
        }
      },
    }),

    video_edit_revise: tool({
      description:
        "Ask for a new cut of a finished edit, with one change in words. It's a new job the person approves; the last cut stays as it is.",
      inputSchema: z.object({
        job: z.uuid(),
        change: z.string().trim().min(1).max(1000),
      }),
      execute: async ({ job, change }) => {
        const [parent] = await withUser(env.userId, (tx) =>
          tx.select().from(editJobs).where(eq(editJobs.id, job))
        )
        if (!parent) throw new Error("That edit isn't there.")
        if (["queued", "running", "lost"].includes(parent.status))
          throw new Error("That edit is still going. Wait for it, or cancel it first.")
        const next = randomUUID()
        await queueEdit(
          env.userId,
          parent.deviceId,
          {
            project: parent.project,
            job: next,
            // shortcut: a revision re-makes from the brief plus the change; anchored notes come with ED15
            brief: `${parent.brief.slice(0, 2900)}\n\nChange asked for: ${change}`,
            effort: "best",
            revisionOf: parent.id,
            ...(parent.recipe && { recipe: parent.recipe }),
          },
          { threadId: env.threadId, revisionOf: parent.id }
        )
        return { job: next, status: "queued", revisionOf: parent.id }
      },
    }),
  }
}
