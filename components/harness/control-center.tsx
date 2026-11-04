"use client"

import * as React from "react"
import { formatDistanceToNowStrict } from "date-fns"
import {
  ActivityIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  PlayIcon,
  ServerIcon,
  SquareIcon,
  StethoscopeIcon,
} from "lucide-react"

import { cancelAction, dispatchAction } from "@/actions/harness-control"
import { Command } from "@/components/harness/command"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { ControlCenterData } from "@/lib/harness/control"
import { formatInr } from "@/lib/money"
import { cn } from "@/lib/utils"

// The Control Center (CONTROL_CENTER.md): everything `kriya` does in the
// terminal, as controls. Actions are queued for one of the person's own
// computers and run there by `kriya daemon`; what a computer allows (Full
// access, serving) is set on the computer, never here. Approvals still come
// to Waiting for you and the Inbox.

type Device = ControlCenterData["devices"][number]
type Dispatch = ControlCenterData["dispatches"][number]

const MODES = [
  { id: "ask", label: "Ask", what: "Asks before changing files or running tools." },
  {
    id: "auto",
    label: "Auto",
    what: "Works in the folder on its own; refuses what would need your OK.",
  },
  { id: "read", label: "Read only", what: "Reads and answers; changes nothing." },
  { id: "plan", label: "Plan", what: "Writes a plan, changes nothing." },
  {
    id: "full",
    label: "Full access",
    what: "No sandbox, no questions. Only if the computer allows it.",
  },
] as const
type Mode = (typeof MODES)[number]["id"]

const SWITCHES = [
  {
    id: "loopV2",
    label: "Kriya Loop v2",
    what: "Plan steps with dependencies, checks that resist tampering",
  },
  {
    id: "budget",
    label: "Turn budget",
    what: "Stops a turn at 150 steps or when it stalls",
  },
  { id: "anchor", label: "Context anchor", what: "Keeps your words through compaction" },
  {
    id: "browser",
    label: "Browser",
    what: "The agent's browser for apps on the computer",
  },
] as const
type Switches = Record<(typeof SWITCHES)[number]["id"], boolean>

const KIND_LABEL: Record<Dispatch["kind"], string> = {
  run: "Task",
  doctor: "Health check",
  rule_confirm: "Confirm rule",
  rule_dismiss: "Dismiss rule",
  handoff: "Handoff to cloud",
  pull: "Pull to computer",
  serve_start: "Start serving",
  serve_stop: "Stop serving",
}
// Polling reads a plain GET (a server action would refresh the whole route)
async function refreshControlCenter(): Promise<ControlCenterData | null> {
  const res = await fetch("/harness/control-data", {
    cache: "no-store",
    credentials: "same-origin",
  })
  return res.ok ? ((await res.json()) as ControlCenterData) : null
}

const ACTIVE = new Set(["queued", "claimed", "running", "canceling"])
const STATUS: Record<Dispatch["status"], { label: string; tone: string }> = {
  queued: { label: "Waiting for the computer", tone: "text-muted-foreground" },
  claimed: { label: "Starting", tone: "text-rigel" },
  running: { label: "Running", tone: "text-rigel" },
  canceling: { label: "Stopping", tone: "text-betelgeuse" },
  done: { label: "Done", tone: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", tone: "text-destructive" },
  canceled: { label: "Stopped", tone: "text-muted-foreground" },
  expired: { label: "Not picked up", tone: "text-muted-foreground" },
}

const ago = (value: Date | string | null) =>
  value ? formatDistanceToNowStrict(new Date(value), { addSuffix: true }) : ""

function Card({
  title,
  icon,
  children,
  action,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="glass flex flex-col gap-3 rounded-[20px] px-4 py-4">
      <header className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold">
          <span className="text-rigel">{icon}</span>
          {title}
        </h3>
        {action}
      </header>
      {children}
    </section>
  )
}

function Select({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="label-mono">{label}</span>
      <select
        className="min-h-11 w-full min-w-0 rounded-xl border bg-surface px-3 text-[13.5px] sm:min-h-9"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  )
}

function Result({ item }: { item: Dispatch }) {
  const r = (item.result ?? {}) as Record<string, unknown>
  if (item.kind === "doctor" && Array.isArray(r.checks)) {
    return (
      <ul className="flex flex-col gap-1.5">
        {(r.checks as { name: string; ok: boolean; detail?: string; fix?: string }[]).map(
          (c) => (
            <li key={c.name} className="flex items-start gap-2 text-[12.5px]">
              <span
                className={cn(
                  "mt-0.5 font-mono",
                  c.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                )}
                aria-hidden
              >
                {c.ok ? "✓" : "✗"}
              </span>
              <span className="min-w-0">
                <span className="font-medium">{c.name}</span>
                {c.detail && <span className="text-muted-foreground"> · {c.detail}</span>}
                {!c.ok && c.fix && (
                  <span className="block text-muted-foreground">Fix: {c.fix}</span>
                )}
              </span>
            </li>
          )
        )}
      </ul>
    )
  }
  const text =
    typeof r.answer === "string"
      ? r.answer
      : typeof r.output === "string"
        ? r.output
        : typeof r.error === "string"
          ? r.error
          : ""
  if (!text && r.exitCode === undefined) return null
  return (
    <details className="text-[12.5px]">
      <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground sm:min-h-8">
        {r.exitCode !== undefined ? `Exit ${String(r.exitCode)}` : "Details"}
        {typeof r.branch === "string" && ` · branch ${r.branch}`}
        {typeof r.workspace === "string" && ` · workspace ${r.workspace.slice(0, 8)}`}
      </summary>
      {text && (
        <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-muted/50 p-2.5 font-mono text-[11.5px] whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </details>
  )
}

export function ControlCenter({
  initial,
  spend,
  handoffOn,
  serveOn,
}: {
  initial: ControlCenterData
  spend: { used: number; cap: number; unpriced: number }
  handoffOn: boolean
  serveOn: boolean
}) {
  const [data, setData] = React.useState(initial)
  const [deviceId, setDeviceId] = React.useState(
    initial.devices.find((d) => d.online)?.id ?? initial.devices[0]?.id ?? ""
  )
  const device: Device | undefined = data.devices.find((d) => d.id === deviceId)
  const projects = device?.projects ?? []
  const [chosen, setProject] = React.useState(projects[0]?.id ?? "")
  // The chosen folder while this computer still offers it, else its first
  const project = projects.some((p) => p.id === chosen) ? chosen : (projects[0]?.id ?? "")
  const [prompt, setPrompt] = React.useState("")
  const [mode, setMode] = React.useState<Mode>("ask")
  const [switches, setSwitches] = React.useState<Switches>({
    loopV2: false,
    budget: true,
    anchor: false,
    browser: true,
  })
  const [note, setNote] = React.useState("")
  const [message, setMessage] = React.useState<{
    tone: "error" | "ok"
    text: string
  } | null>(null)
  const [pending, startTransition] = React.useTransition()
  const caps = (device?.capabilities ?? {}) as {
    fullAccess?: boolean
    serve?: boolean
    handoff?: boolean
  }

  const busy =
    data.dispatches.some((d) => ACTIVE.has(d.status)) ||
    data.runs.some((r) => r.status === "running" && !r.lost)
  React.useEffect(() => {
    const timer = setInterval(
      async () => {
        if (document.visibilityState !== "visible") return
        const fresh = await refreshControlCenter().catch(() => null)
        if (fresh) setData(fresh)
      },
      busy ? 3000 : 15000
    )
    return () => clearInterval(timer)
  }, [busy])

  const send = (
    kind: Dispatch["kind"],
    payload: Record<string, unknown>,
    done?: () => void
  ) => {
    if (!device) return
    setMessage(null)
    startTransition(async () => {
      const answer = await dispatchAction({ deviceId: device.id, kind, payload })
      if ("error" in answer)
        setMessage({ tone: "error", text: answer.error ?? "That didn't work." })
      else {
        setMessage({ tone: "ok", text: `${KIND_LABEL[kind]} sent to ${device.name}.` })
        done?.()
        const fresh = await refreshControlCenter().catch(() => null)
        if (fresh) setData(fresh)
      }
    })
  }
  const stop = (id: string) =>
    startTransition(async () => {
      const answer = await cancelAction({ id })
      if ("error" in answer)
        setMessage({ tone: "error", text: answer.error ?? "That didn't work." })
      const fresh = await refreshControlCenter().catch(() => null)
      if (fresh) setData(fresh)
    })

  const online = !!device?.online
  const disabled = !online || pending
  const selected = projects.find((p) => p.id === project)
  const rules = (device?.rules ?? []) as {
    project: string
    n: number
    text: string
    status: string
  }[]
  const proposed = rules.filter((r) => r.status === "proposed")
  const serving = data.dispatches.find(
    (d) => d.deviceId === deviceId && d.kind === "serve_start" && ACTIVE.has(d.status)
  )
  const usedShare = spend.cap > 0 ? Math.min(1, spend.used / spend.cap) : 0

  if (data.devices.length === 0)
    return (
      <div className="glass rounded-[20px] px-4 py-4 text-[13px] text-muted-foreground">
        Sign in a computer with kriya login, then start kriya daemon on it to control it
        from here.
      </div>
    )

  return (
    <div className="flex flex-col gap-3">
      {/* Computers */}
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Computer">
        {data.devices.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={d.id === deviceId}
            onClick={() => setDeviceId(d.id)}
            className={cn(
              "flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-[13px]",
              d.id === deviceId
                ? "border-rigel bg-rigel-soft text-foreground"
                : "text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "size-2 rounded-full",
                d.online ? "bg-emerald-500" : "bg-muted-foreground/40"
              )}
              aria-hidden
            />
            {d.name}
            <span className="sr-only">{d.online ? "listening" : "not listening"}</span>
          </button>
        ))}
      </div>
      {!online && (
        <div className="glass flex flex-col gap-2 rounded-[20px] px-4 py-3.5 text-[13px]">
          <span className="text-muted-foreground">
            {device?.polledAt
              ? `${device.name} stopped listening ${ago(device.polledAt)}.`
              : `${device?.name ?? "This computer"} isn't listening yet.`}{" "}
            Start the daemon on it to run anything from here:
          </span>
          <Command command="kriya daemon" />
          <span className="text-[12px] text-faint">
            Keep it running in the background with kriya daemon install. Add
            --allow-full-access or --allow-serve there to allow those from Kriya.
          </span>
        </div>
      )}

      {message && (
        <div
          role={message.tone === "error" ? "alert" : "status"}
          className={cn(
            "rounded-xl px-3.5 py-2.5 text-[13px]",
            message.tone === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-rigel-soft"
          )}
        >
          {message.text}
        </div>
      )}

      {/* Task composer */}
      <Card title="New task" icon={<PlayIcon className="size-4" />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Folder"
            value={project}
            onChange={setProject}
            disabled={!projects.length}
          >
            {projects.length ? (
              projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.path}
                </option>
              ))
            ) : (
              <option value="">No folders offered yet</option>
            )}
          </Select>
          <Select label="Mode" value={mode} onChange={(v) => setMode(v as Mode)}>
            {MODES.map((m) => (
              <option
                key={m.id}
                value={m.id}
                disabled={m.id === "full" && !caps.fullAccess}
              >
                {m.label}
                {m.id === "full" && !caps.fullAccess ? " (off on this computer)" : ""}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-[12px] text-muted-foreground">
          {MODES.find((m) => m.id === mode)?.what}
        </p>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do?"
          aria-label="Task"
          maxLength={4000}
          className="min-h-28 text-[14px]"
        />
        <fieldset className="grid gap-1.5 sm:grid-cols-2">
          <legend className="label-mono mb-1">Engine</legend>
          {SWITCHES.map((s) => (
            <label
              key={s.id}
              className="flex min-h-11 items-center gap-2.5 rounded-xl px-1 text-[13px] sm:min-h-9"
            >
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-rigel)]"
                checked={switches[s.id]}
                onChange={(e) => setSwitches({ ...switches, [s.id]: e.target.checked })}
              />
              <span className="min-w-0">
                <span className="font-medium">{s.label}</span>
                <span className="block text-[11.5px] text-muted-foreground">
                  {s.what}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button
          className="min-h-11 self-start"
          disabled={disabled || !project || !prompt.trim()}
          onClick={() =>
            send("run", { project, prompt: prompt.trim(), mode, switches }, () =>
              setPrompt("")
            )
          }
        >
          <PlayIcon className="size-4" /> Run on {device?.name ?? "computer"}
        </Button>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Health */}
        <Card title="Health check" icon={<StethoscopeIcon className="size-4" />}>
          <p className="text-[12.5px] text-muted-foreground">
            Node, DeepSeek Harness, the sign-in and the connection to Kriya, checked on
            the computer.
          </p>
          <Button
            variant="outline"
            className="min-h-11 self-start"
            disabled={disabled}
            onClick={() => send("doctor", {})}
          >
            Run health check
          </Button>
        </Card>

        {/* Handoff and pull */}
        {handoffOn && (
          <Card title="Cloud workspace" icon={<CloudUploadIcon className="size-4" />}>
            <p className="text-[12.5px] text-muted-foreground">
              {selected?.git
                ? `Moves ${selected.name}'s uncommitted work to a cloud workspace, or brings a workspace's changes back on a new branch.`
                : "Needs a git repository with its HEAD on GitHub."}
            </p>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note for the cloud agent (optional)"
              aria-label="Handoff note"
              maxLength={500}
              className="min-h-11 rounded-xl border bg-surface px-3 text-[13px] sm:min-h-9"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={disabled || !selected?.git || !caps.handoff}
                onClick={() =>
                  send(
                    "handoff",
                    { project, ...(note.trim() && { note: note.trim() }) },
                    () => setNote("")
                  )
                }
              >
                <CloudUploadIcon className="size-4" /> Handoff to cloud
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={disabled || !selected?.git || !caps.handoff}
                onClick={() => send("pull", { project })}
              >
                <CloudDownloadIcon className="size-4" /> Pull to computer
              </Button>
            </div>
          </Card>
        )}

        {/* Serve */}
        {serveOn && (
          <Card title="Remote worker" icon={<ServerIcon className="size-4" />}>
            <p className="text-[12.5px] text-muted-foreground">
              {caps.serve
                ? `Lets your Kriya agents run commands in new subfolders of ${selected?.name ?? "a folder"} while it's on.`
                : "Off on this computer. Start kriya daemon --allow-serve there to allow it from Kriya."}
            </p>
            {serving ? (
              <Button
                variant="outline"
                className="min-h-11 self-start"
                disabled={disabled}
                onClick={() => send("serve_stop", {})}
              >
                <SquareIcon className="size-4" /> Stop serving
              </Button>
            ) : (
              <Button
                variant="outline"
                className="min-h-11 self-start"
                disabled={disabled || !caps.serve || !project}
                onClick={() => send("serve_start", { project })}
              >
                <ServerIcon className="size-4" /> Serve {selected?.name ?? ""}
              </Button>
            )}
          </Card>
        )}

        {/* Usage */}
        <Card title="Usage this month" icon={<ActivityIcon className="size-4" />}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-xl tabular-nums">
              {formatInr(spend.used)}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {spend.cap > 0 ? `of ${formatInr(spend.cap)}` : "Not in your plan yet"}
            </span>
          </div>
          {spend.cap > 0 && (
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label="Share of the monthly limit used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedShare * 100)}
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  usedShare > 0.9 ? "bg-destructive" : "bg-rigel"
                )}
                style={{ width: `${usedShare * 100}%` }}
              />
            </div>
          )}
          {spend.unpriced > 0 && (
            <span className="text-[11.5px] text-muted-foreground">
              {spend.unpriced} requests not priced yet
            </span>
          )}
        </Card>
      </div>

      {/* Rules */}
      {proposed.length > 0 && (
        <Card title="Learned rules" icon={<StethoscopeIcon className="size-4" />}>
          <p className="text-[12.5px] text-muted-foreground">
            Kriya Loop v2 proposed these from failures it saw twice. Builders follow a
            rule only after you confirm it.
          </p>
          <ul className="flex flex-col divide-y">
            {proposed.map((r) => (
              <li
                key={`${r.project}:${r.n}`}
                className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-[13px]">
                  {r.text}
                  <span className="block text-[11.5px] text-muted-foreground">
                    {projects.find((p) => p.id === r.project)?.name ?? "A folder"}
                  </span>
                </span>
                <span className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    className="min-h-11 sm:min-h-8"
                    disabled={disabled}
                    onClick={() => send("rule_confirm", { project: r.project, n: r.n })}
                  >
                    Confirm rule
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 sm:min-h-8"
                    disabled={disabled}
                    onClick={() => send("rule_dismiss", { project: r.project, n: r.n })}
                  >
                    Dismiss
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Activity */}
      <Card title="Activity" icon={<ActivityIcon className="size-4" />}>
        {data.runs.length === 0 && data.dispatches.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">
            Nothing yet. What you run here or in a terminal on a listening computer shows
            up here.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {data.dispatches.map((d) => {
              const payload = d.payload as {
                prompt?: string
                mode?: string
                project?: string
              }
              const dev = data.devices.find((x) => x.id === d.deviceId)
              return (
                <li key={d.id} className="flex flex-col gap-1.5 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 text-[13px]">
                      <span className="font-medium">{KIND_LABEL[d.kind]}</span>
                      {payload.prompt && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {payload.prompt.slice(0, 140)}
                        </span>
                      )}
                      <span className="block text-[11.5px] text-muted-foreground">
                        {dev?.name ?? "A computer"}
                        {payload.project &&
                          ` · ${dev?.projects.find((p) => p.id === payload.project)?.name ?? "folder"}`}
                        {payload.mode &&
                          ` · ${MODES.find((m) => m.id === payload.mode)?.label}`}{" "}
                        · {ago(d.createdAt)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span
                        className={cn("text-[12px] font-medium", STATUS[d.status].tone)}
                      >
                        {STATUS[d.status].label}
                      </span>
                      {(d.status === "queued" ||
                        d.status === "claimed" ||
                        d.status === "running") && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11 sm:min-h-8"
                          onClick={() => stop(d.id)}
                          aria-label={`Stop ${KIND_LABEL[d.kind]}`}
                        >
                          Stop
                        </Button>
                      )}
                    </span>
                  </div>
                  <Result item={d} />
                </li>
              )
            })}
            {data.runs
              .filter((r) => r.source === "terminal")
              .map((r) => (
                <li
                  key={r.id}
                  className="flex items-start justify-between gap-3 py-2.5 text-[13px]"
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      From the terminal: kriya {r.kind === "app" ? "" : r.kind}
                    </span>
                    <span className="block text-[11.5px] text-muted-foreground">
                      {data.devices.find((x) => x.id === r.deviceId)?.name ??
                        "A computer"}
                      {r.project && ` · ${r.project}`}
                      {r.mode &&
                        ` · ${MODES.find((m) => m.id === r.mode)?.label ?? r.mode}`}
                      {Object.entries(r.switches ?? {})
                        .filter(([, on]) => on)
                        .map(([k]) => ` · ${k}`)
                        .join("")}{" "}
                      · {ago(r.updatedAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[12px] font-medium",
                      r.status === "running" && !r.lost
                        ? "text-rigel"
                        : r.status === "completed"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground"
                    )}
                  >
                    {r.lost
                      ? "Lost contact"
                      : r.status === "running"
                        ? "Running"
                        : r.status === "completed"
                          ? "Completed"
                          : r.status === "failed"
                            ? `Failed${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`
                            : r.status === "blocked"
                              ? "Blocked"
                              : "Stopped"}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
