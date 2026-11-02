// P5 adapted from DeepSeek Harness @ ce7073d51254c26cd63b22a60835b8f948deb447 (MIT, NOTICE.md):
// guard/repeat-tool-reminder

import { tool } from "ai"
import { z } from "zod"

import { FOREIGN } from "@/lib/agent/tools"
import { publishChanges } from "@/lib/cloud/publish"
import type { TaskWorkspace } from "@/lib/cloud/session"

// The workspace_* tools (track C, TOOLS_AND_CONTRACTS §3) on one task's
// TaskWorkspace: everything happens in the sandbox, through the runner, and
// nothing reaches anyone outside Kriya except workspace_publish (R4, a side
// effect the person approves call by call). A
// repository is written by other people, so every output that carries its
// content says so (FOREIGN), and its reads count as private content.

// owner/name, as the workspaces.repo check in SQL
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/
const path = z.string().min(1).max(1024)
const MAX_CONTENT = 512 * 1024
// Of each stream, and of a diff: the start and the end the model sees
const MODEL_CHARS = 4000
const TAIL_CHARS = 2000

const REPEAT_NOTE =
  "This is the third time in a row you ran this exact command. Change your approach, or stop and tell the person what is blocking you."

const failure = (error: unknown) => ({
  error: error instanceof Error ? error.message : "The workspace call failed.",
})

async function attempt<T extends object>(work: () => Promise<T>) {
  try {
    return { notice: FOREIGN, ...(await work()) }
  } catch (error) {
    return failure(error)
  }
}

const clip = (text: string) =>
  text.length <= 2 * MODEL_CHARS
    ? text
    : `${text.slice(0, MODEL_CHARS)}\n[${text.length - 2 * MODEL_CHARS} characters left out]\n${text.slice(-MODEL_CHARS)}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type RunResult = {
  notice: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  logPath: string
  note?: string
}

export function createWorkspaceTools(
  workspace: TaskWorkspace,
  // repos: GitHub is connected, so a repository can be imported; publish:
  // cloud.publish is on too
  options: { repos: boolean; publish?: boolean }
) {
  // P5: the same command, again and again
  let last = ""
  let repeats = 0

  return {
    workspace_open: tool({
      description:
        "Open this thread's cloud workspace: a private Linux sandbox where you can read and change files and run commands (tests, builds, scripts). Give a GitHub repository (owner/name, and a branch if not the default) to start from it, or nothing for a blank project. Calling it again returns the same workspace.",
      inputSchema: z.object({
        repo: z.string().regex(REPO).optional().describe("owner/name"),
        ref: z.string().regex(REF).optional().describe("A branch or tag"),
      }),
      execute: async ({ repo, ref }) => {
        if (repo && !options.repos) {
          return {
            error:
              "Opening a GitHub repository needs GitHub connected and importing switched on, and this task has neither. Open a blank workspace instead, or ask the person to connect GitHub under Account → Connected accounts.",
          }
        }
        return attempt(() => workspace.open({ repo, ref }))
      },
    }),
    workspace_run: tool({
      description:
        "Run a shell command in the workspace with bash, in /workspace or cwd: tests, a build, git status, installing dependencies. Returns the exit code and output; long output is cut to its start and end, and the full log stays in the workspace at logPath. Anything the command leaves running is stopped when it ends or times out.",
      inputSchema: z.object({
        command: z.string().min(1).max(4000),
        cwd: path.optional().describe("A folder inside the workspace"),
        timeoutSeconds: z.number().int().min(1).max(1800).optional(),
      }),
      // A generator: the output's tail streams to the person while it runs
      execute: async function* ({ command, cwd, timeoutSeconds }, { abortSignal }) {
        const key = JSON.stringify([command, cwd ?? ""])
        repeats = key === last ? repeats + 1 : 1
        last = key
        let tail = ""
        let settled: { end: RunResult } | { error: unknown } | null = null
        const running = (async () => {
          try {
            const client = await workspace.client()
            const end = await client.exec(
              {
                command,
                cwd,
                timeoutSeconds: Math.min(
                  timeoutSeconds ?? workspace.commandTimeoutSeconds,
                  workspace.commandTimeoutSeconds
                ),
              },
              {
                signal: abortSignal,
                onOutput: (event) => (tail = (tail + event.text).slice(-TAIL_CHARS)),
              }
            )
            settled = {
              end: {
                notice: FOREIGN,
                exitCode: end.exitCode,
                signal: end.signal,
                timedOut: end.timedOut,
                durationMs: end.durationMs,
                stdout: end.stdout,
                stderr: end.stderr,
                truncated: end.truncated,
                logPath: end.logPath,
                ...(repeats >= 3 && { note: REPEAT_NOTE }),
              },
            }
          } catch (error) {
            settled = { error }
          }
        })()
        while (!settled) {
          await Promise.race([running, sleep(1000)])
          if (!settled) yield { status: "running" as const, tail }
        }
        const done = settled as { end: RunResult } | { error: unknown }
        if ("error" in done) yield failure(done.error)
        else yield done.end
      },
      toModelOutput: ({ output }) => {
        if ("error" in output) return { type: "text" as const, value: output.error }
        if ("status" in output) return { type: "text" as const, value: output.tail }
        const exit =
          output.exitCode ??
          (output.timedOut ? "none (timed out)" : `none (${output.signal ?? "stopped"})`)
        return {
          type: "text" as const,
          value: [
            output.notice,
            `Exit code: ${exit}, ${output.durationMs} ms. Full log: ${output.logPath}`,
            `--- stdout ---\n${clip(output.stdout)}`,
            `--- stderr ---\n${clip(output.stderr)}`,
            ...(output.note ? [output.note] : []),
          ].join("\n"),
        }
      },
    }),
    workspace_read: tool({
      description:
        "Read a file in the workspace (up to 2000 lines at a time; give startLine and endLine for more). Read a file before you change it.",
      inputSchema: z.object({
        path,
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
      execute: async (input) =>
        attempt(async () => (await workspace.client()).read(input)),
    }),
    workspace_list: tool({
      description:
        "List the files and folders in the workspace (or under path), leaving out what .gitignore ignores.",
      inputSchema: z.object({
        path: path.optional(),
        depth: z.number().int().min(1).max(4).optional(),
      }),
      execute: async (input) =>
        attempt(async () => (await workspace.client()).list(input)),
    }),
    workspace_search: tool({
      description:
        "Search the workspace's files for a regular expression (or exact text with fixed), optionally under path or matching a glob like *.ts. Returns file, line and text.",
      inputSchema: z.object({
        pattern: z.string().min(1).max(200),
        path: path.optional(),
        glob: z.string().min(1).max(200).optional(),
        fixed: z.boolean().optional(),
      }),
      execute: async (input) =>
        attempt(async () => (await workspace.client()).search(input)),
    }),
    workspace_write: tool({
      description:
        "Create a file, or replace one you have read, with the whole content. For a few changed lines use workspace_edit.",
      inputSchema: z.object({ path, content: z.string().max(MAX_CONTENT) }),
      execute: async ({ path: target, content }) =>
        attempt(async () => {
          const { created } = await (
            await workspace.client()
          ).write({ path: target, content })
          return { path: target, created }
        }),
    }),
    workspace_edit: tool({
      description:
        "Replace exact text in a file you have read. oldText must appear exactly once (include surrounding lines to make it unique) unless replaceAll is set.",
      inputSchema: z.object({
        path,
        oldText: z.string().min(1).max(MAX_CONTENT),
        newText: z.string().max(MAX_CONTENT),
        replaceAll: z.boolean().optional(),
      }),
      execute: async (input) =>
        attempt(async () => {
          const { replacements } = await (await workspace.client()).edit(input)
          return { path: input.path, replacements }
        }),
    }),
    workspace_patch: tool({
      description:
        "Change several files at once with a patch: *** Begin Patch, then *** Add File: path (lines starting with +), *** Update File: path (hunks after @@ with ' ', '-' and '+' lines) or *** Delete File: path, then *** End Patch. All of it applies or none of it does; changed files must have been read.",
      inputSchema: z.object({ patch: z.string().min(1).max(MAX_CONTENT) }),
      execute: async ({ patch }) =>
        attempt(async () => (await workspace.client()).patch(patch)),
    }),
    workspace_changes: tool({
      description:
        "List what changed in the workspace since it started (or since the repository's base commit): each file with lines added and removed, and the diff.",
      inputSchema: z.object({}),
      execute: async () =>
        attempt(async () => {
          const changes = await (await workspace.client()).changes()
          await workspace.noteChanges({
            files: changes.files.length,
            added: changes.files.reduce((n, f) => n + f.added, 0),
            removed: changes.files.reduce((n, f) => n + f.removed, 0),
          })
          return changes
        }),
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? output.error
            : [
                output.notice,
                // workspace_publish names the change set the person approves
                `changeSetId: ${output.changeSetId}`,
                JSON.stringify(output.files),
                clip(output.diff),
                ...(output.truncated
                  ? ["(The diff was cut; read the files for the rest.)"]
                  : []),
              ].join("\n"),
      }),
    }),
    ...(options.publish && options.repos
      ? {
          workspace_publish: tool({
            description:
              "Publish the workspace's changes to its GitHub repository as one commit on a new branch (kriya/...) and a draft pull request into the branch it started from. Call workspace_changes first and pass its changeSetId: the person approves exactly that change set, and it is refused if the files changed since. It never touches an existing branch or merges.",
            inputSchema: z.object({
              repo: z.string().regex(REPO).describe("The workspace's own repository"),
              changeSetId: z.string().regex(/^[0-9a-f]{64}$/),
              branch: z
                .string()
                .regex(/^kriya\/[a-z0-9._-]{1,60}$/)
                .describe("A new branch, e.g. kriya/fix-date-test"),
              title: z.string().min(1).max(120),
              body: z.string().max(8000),
            }),
            execute: async (input) => {
              try {
                return await publishChanges(workspace, input)
              } catch (error) {
                return failure(error)
              }
            },
          }),
        }
      : {}),
  }
}
