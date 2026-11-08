import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import {
  BrainIcon,
  ChevronRightIcon,
  ClapperboardIcon,
  CloudIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  WandSparklesIcon,
} from "lucide-react"

import { Devices } from "@/components/account/devices"
import { Command } from "@/components/harness/command"
import { ControlCenter } from "@/components/harness/control-center"
import { LiveList } from "@/components/harness/live"
import { HarnessApproval } from "@/components/inbox/harness-approval"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"
import { controlCenter } from "@/lib/harness/control"
import { liveSessions } from "@/lib/harness/live"
import { log } from "@/lib/log"
import { harnessSpend } from "@/lib/harness/devices"
import { formatInr } from "@/lib/money"
import { studioOn } from "@/lib/skill-studio"
import { cn } from "@/lib/utils"
import { listEdits, type EditRow } from "@/queries/editing"
import { harnessHome, listDevices, type HarnessHome } from "@/queries/harness"

export const metadata: Metadata = { title: "Kriya Harness" }

// Kriya Harness inside Kriya Tavi (owner 2026-11-02): one place for the
// person's computers, what they did there, their cloud workspaces, device
// approvals, spend, and how to start. Every read is the person's own
// (withUser); every action is an existing one (actions/harness.ts). Only
// with harness.api on; each part follows its own switch.

const PLATFORMS = { darwin: "macOS", linux: "Linux", win32: "Windows" } as const

// Short: a phone's row also holds the title and Watch
const EDIT_LABEL: Record<EditRow["status"], string> = {
  queued: "Queued",
  running: "Running",
  delivered: "Ready",
  delivered_with_notes: "With notes",
  blocked: "Blocked",
  failed: "Failed",
  canceled: "Canceled",
  expired: "Not started",
  lost: "Lost touch",
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="glass rounded-[20px] px-4 py-5 text-center text-[13px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

const threadHref = (row: {
  agentId: string | null
  squadId: string | null
  threadId: string | null
}) =>
  row.agentId
    ? `/a/${row.agentId}/${row.threadId}`
    : row.squadId
      ? `/s/${row.squadId}/${row.threadId}`
      : null

function SessionRow({
  href,
  icon,
  title,
  meta,
  status,
}: {
  href: string | null
  icon: React.ReactNode
  title: string
  meta: string
  status?: { label: string; tone?: string }
}) {
  const body = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-rigel-soft text-rigel">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="truncate text-[13.5px] font-medium">{title}</span>
        <span className="truncate text-[12px] text-muted-foreground">{meta}</span>
      </span>
      {status && (
        <span
          className={cn(
            "shrink-0 font-mono text-[10.5px]",
            status.tone ?? "text-muted-foreground"
          )}
        >
          {status.label}
        </span>
      )}
      {href && <ChevronRightIcon className="size-4 shrink-0 text-faint" />}
    </>
  )
  const classes = "flex min-h-14 items-center gap-3 px-4 py-2.5"
  return href ? (
    <Link href={href} className={cn(classes, "transition-colors hover:bg-accent/40")}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  )
}

// Kriya Harness modes, as the client defines them (kriya-harness
// src/modes.js): one sandbox mode and one approval policy each; approval
// "never" refuses, it never allows
const MODES = [
  {
    flag: "ask",
    label: "Ask",
    note: "Default",
    what: "Works in this folder and asks before anything beyond it, there or here on your phone.",
  },
  {
    flag: "auto",
    label: "Auto",
    what: "Works in this folder without asking. Anything that would need your OK is refused instead.",
  },
  {
    flag: "read",
    label: "Read only",
    what: "Reads and answers; changes no file.",
  },
  {
    flag: "plan",
    label: "Plan",
    note: "kriya run; in the app, /plan",
    what: "Explores and writes a step-by-step plan; changes no file.",
  },
  {
    flag: "full",
    label: "Full access",
    note: "Only when you choose it",
    what: "No sandbox and no questions. Only on a machine you can afford to change.",
  },
]

const WORKSPACE_STATUS: Record<string, { label: string; tone?: string }> = {
  new: { label: "starting" },
  starting: { label: "starting" },
  running: { label: "working", tone: "text-rigel" },
  paused: { label: "paused" },
  closing: { label: "closing…" },
  failed: { label: "couldn't start", tone: "text-destructive" },
}

function CloudRow({ row }: { row: HarnessHome["cloud"][number] }) {
  const where = row.repo
    ? `${row.repo}${row.baseRef ? ` · ${row.baseRef}` : ""}`
    : "Blank project"
  const changes = row.changes?.files
    ? ` · ${row.changes.files} ${row.changes.files === 1 ? "file" : "files"} changed`
    : ""
  return (
    <SessionRow
      href={threadHref(row)}
      icon={
        row.provider === "device" ? (
          <MonitorSmartphoneIcon className="size-4" />
        ) : (
          <CloudIcon className="size-4" />
        )
      }
      title={row.title ?? where}
      meta={`${row.provider === "device" ? "On your computer" : "In the cloud"} · ${where}${changes}`}
      status={row.closing ? { label: "closing…" } : WORKSPACE_STATUS[row.status]}
    />
  )
}

export default async function HarnessPage() {
  if ((await getSetting("harness.api")) !== "on") notFound()
  const user = await requireUser()
  const [devices, home, spend, plan] = await Promise.all([
    listDevices(user.id),
    harnessHome(user.id),
    harnessSpend(user.id),
    getPlan(user.id),
  ])
  const on = async (key: Parameters<typeof getSetting>[0]) =>
    (await getSetting(key)) === "on"
  const [gateway, mirror, handoff, world, cloudOn, memoryV2, studio, control] =
    await Promise.all([
      on("harness.gateway"),
      on("harness.mirror"),
      on("harness.handoff"),
      on("harness.deviceWorld"),
      on("cloud.workspaces"),
      on("agents.memoryV2"),
      studioOn(),
      on("harness.controlCenter"),
    ])
  // The Control Center (CONTROL_CENTER.md): only with its switch on
  const center = control ? await controlCenter(user.id) : null
  // Track E: edits an agent asked a computer for, only with editing.tavi on
  const edits = (await on("editing.tavi")) ? await listEdits(user.id) : null
  const editRoom = await on("editing.review")
  // Remote Control (REMOTE_CONTROL.md): only with its switch on
  // A failed read (the switch on before its migration) costs this section, not the page
  const live = (await on("harness.remoteControl"))
    ? await liveSessions(user.id).catch((error) => {
        log.error("remote control list failed", { error: String(error) })
        return null
      })
    : null
  // Track S: a plan drawn in Flows runs here through the same daemon
  const flows = center && (await on("studio.flows")) && (await on("studio.deviceFlows"))
  const install = await getSetting("harness.installCommand")
  const beta = (await getSetting("harness.releaseStage")) !== "ga"
  const cap = Number(plan.harnessMonthlyMicroInr)
  const signedIn = devices.length > 0

  const commands = [
    {
      command: "kriya",
      what: "Opens Kriya Harness in your browser, working as your agent.",
    },
    {
      command: 'kriya run "fix the failing test"',
      what: "One job from the terminal; prints the answer.",
    },
    {
      command: 'kriya run --mode plan "add sign-in with Google"',
      what: "A plan for the job, with nothing changed. Any mode works with --mode.",
    },
    handoff &&
      cloudOn && {
        command: "kriya handoff",
        what: "Moves this folder's work to a Kriya cloud workspace. Follow it from your phone.",
      },
    handoff &&
      cloudOn && {
        command: "kriya pull",
        what: "Brings a workspace's changes back to your computer on a new branch.",
      },
    world && {
      command: "kriya serve",
      what: "Lets your Kriya agents work in one folder on this computer while it's on.",
    },
    control && {
      command: "kriya daemon",
      what: "Lets you run tasks, health checks and more on this computer from here and your phone.",
    },
    { command: "kriya acp", what: "Connects editors that speak ACP to your agent." },
    {
      command: "kriya doctor",
      what: "Checks the install, your sign-in and the connection.",
    },
    { command: "kriya logout", what: "Signs this computer out of Kriya." },
  ].filter((item) => !!item)

  const start = (
    <Section
      title="Get started"
      description="Three steps on your computer. You approve the sign-in here, and choose which agent it works as."
    >
      <ol className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
        <li className="flex flex-col gap-2.5 px-4 py-3.5">
          <span className="text-[13.5px] font-medium">1. Install Kriya Harness</span>
          {install ? (
            <Command command={install} />
          ) : (
            <span className="text-[13px] leading-relaxed text-muted-foreground">
              Kriya Harness is in private beta. The install command appears here when your
              invitation is ready.
            </span>
          )}
        </li>
        <li className="flex flex-col gap-2.5 px-4 py-3.5">
          <span className="text-[13.5px] font-medium">2. Sign in</span>
          <Command command="kriya login" />
          <span className="text-[12.5px] leading-relaxed text-muted-foreground">
            It shows a code and opens Connect a device in your browser, where you compare
            the code and approve.
          </span>
          <Link
            href="/connect/device"
            className="flex min-h-11 w-fit items-center gap-1 text-[13px] text-rigel hover:underline sm:min-h-8"
          >
            Open Connect a device
            <ChevronRightIcon className="size-3.5" />
          </Link>
        </li>
        <li className="flex flex-col gap-2.5 px-4 py-3.5">
          <span className="text-[13.5px] font-medium">3. Start working</span>
          <Command command="kriya" />
          <span className="text-[12.5px] leading-relaxed text-muted-foreground">
            {gateway
              ? "Your agent works in the folder you start it in. Anything risky asks you first, there or here."
              : "Models for Kriya Harness aren't switched on yet; signing in already works."}
          </span>
        </li>
      </ol>
    </Section>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-9 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <span className="grid size-14 shrink-0 place-items-center rounded-[30%] bg-rigel-soft text-rigel ring-1 ring-rigel/20 sm:size-16">
              <LaptopIcon className="size-7" />
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="flex flex-wrap items-center gap-2.5 font-display text-[30px] leading-none font-normal sm:text-[36px]">
                Kriya Harness
                {beta && (
                  <span className="rounded-full border px-2 py-0.5 font-sans text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                    Beta
                  </span>
                )}
              </h1>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                Your Kriya agents on your own computer: in the terminal, your editor and
                the browser. What they do there shows up here.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border bg-border">
            <div className="flex flex-col gap-1 bg-surface px-4 py-3">
              <span className="label-mono">computers</span>
              <span className="font-mono text-xl tabular-nums">{devices.length}</span>
            </div>
            <div className="flex flex-col gap-1 bg-surface px-4 py-3">
              <span className="label-mono">sessions</span>
              <span className="font-mono text-xl tabular-nums">
                {home.sessions.length + home.cloud.length}
              </span>
            </div>
            <div className="flex flex-col gap-1 bg-surface px-4 py-3">
              <span className="label-mono">spent</span>
              <span className="truncate font-mono text-xl tabular-nums">
                {formatInr(spend.used)}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {cap > 0 ? `of ${formatInr(cap)}` : "Not in your plan yet"}
                {spend.unpriced > 0 && ` · ${spend.unpriced} not priced yet`}
              </span>
            </div>
          </div>
        </header>

        {home.approvals.length > 0 && (
          <Section
            title="Waiting for you"
            description="Your computer asks before it runs these. It stops waiting when one expires."
          >
            <ul className="flex flex-col gap-2.5">
              {home.approvals.map((item) => (
                <HarnessApproval key={item.id} item={item} />
              ))}
            </ul>
          </Section>
        )}

        {flows && signedIn && (
          <Link
            href="/flows"
            className="glass flex min-h-14 items-center gap-3 rounded-[20px] px-4 py-3 text-[13.5px] transition-colors hover:border-rigel/40"
          >
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="font-medium">Design what the agent does here</span>
              <span className="text-[12.5px] text-muted-foreground">
                Draw a plan in Flows, send it to this computer, and watch every step.
              </span>
            </span>
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
          </Link>
        )}
        {live && (
          <Section
            title="Remote Control"
            description="Sessions you switched on in Kriya Harness. Open one to follow it as it works."
          >
            <LiveList initial={live} />
          </Section>
        )}
        {center && signedIn && (
          <Section
            title="Control Center"
            description="Run tasks and checks on your computer from here or your phone. It runs them only while Remote Control is on there, and only in folders it offers."
          >
            <ControlCenter
              initial={center}
              spend={{ used: spend.used, cap, unpriced: spend.unpriced }}
              handoffOn={handoff && cloudOn}
              serveOn={world}
            />
          </Section>
        )}

        {edits && (
          <Section
            title="Edits"
            description="Edits your agents asked a computer for. Your footage stays there, and whether an edit passed is what that computer reported."
          >
            {edits.length === 0 ? (
              <Empty>No edits yet. Ask an agent to cut something.</Empty>
            ) : (
              <div className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
                {edits.map((edit) => (
                  <div key={edit.id} className="flex items-center">
                    <div className="min-w-0 flex-1">
                      <SessionRow
                        href={editRoom ? `/edits/${edit.id}` : null}
                        icon={<ClapperboardIcon className="size-4" />}
                        title={edit.brief}
                        meta={`${edit.device} · ${formatDistanceToNowStrict(edit.createdAt, { addSuffix: true })}`}
                        status={{
                          label:
                            edit.status === "running" && edit.percent !== null
                              ? `${edit.percent}%`
                              : EDIT_LABEL[edit.status],
                        }}
                      />
                    </div>
                    {edit.preview && !editRoom && (
                      <a
                        href={`/api/editing/preview/${edit.preview}`}
                        className="flex min-h-11 shrink-0 items-center pr-4 text-[13px] font-medium text-rigel hover:underline"
                      >
                        Watch
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {!signedIn && start}

        <Section
          title="Sessions"
          description={
            mirror
              ? "Work from your computers (each one chooses what it mirrors) and your open workspaces."
              : "Your open workspaces. Sessions from your computers show here once the mirror is available."
          }
        >
          {home.sessions.length === 0 && home.cloud.length === 0 ? (
            <Empty>
              {signedIn
                ? mirror
                  ? "Nothing yet. Set a computer's mirror to Summaries or Full below, then start a session there."
                  : "Nothing yet. Your cloud workspaces show here while they're open."
                : "Sign in a computer to see its sessions here."}
            </Empty>
          ) : (
            <div className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
              {home.sessions.map((row) => (
                <SessionRow
                  key={row.id}
                  href={threadHref(row)}
                  icon={<LaptopIcon className="size-4" />}
                  title={row.project ?? row.title ?? "Session"}
                  meta={`${row.deviceName} · ${PLATFORMS[row.platform]} · ${formatDistanceToNowStrict(new Date(row.activeAt), { addSuffix: true })}`}
                />
              ))}
              {home.cloud.map((row) => (
                <CloudRow key={row.id} row={row} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Your computers"
          description="Signed in to Kriya Harness. Rename one, choose what it mirrors here, or sign it out at once."
        >
          {signedIn ? (
            <Devices devices={devices} />
          ) : (
            <Empty>No computer is signed in yet.</Empty>
          )}
        </Section>

        {signedIn && start}

        <Section
          title="Modes"
          description="How much the agent may do on its own. Start with kriya --mode auto (or any mode below); in the app, switch with the Permissions control. The sandbox limits file changes, not network use."
        >
          <ul className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
            {MODES.map((mode) => (
              <li key={mode.flag} className="flex flex-col gap-1 px-4 py-3">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13.5px] font-medium">{mode.label}</span>
                  <code className="font-mono text-[11.5px] text-muted-foreground">
                    --mode {mode.flag}
                  </code>
                  {mode.note && (
                    <span className="text-[11.5px] text-faint">{mode.note}</span>
                  )}
                </span>
                <span className="text-[12.5px] leading-relaxed text-muted-foreground">
                  {mode.what}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Commands" description="What you can run once you're signed in.">
          <ul className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
            {commands.map((item) => (
              <li key={item.command} className="flex flex-col gap-1 px-4 py-3">
                <code className="font-mono text-[12.5px] text-foreground">
                  {item.command}
                </code>
                <span className="text-[12.5px] leading-relaxed text-muted-foreground">
                  {item.what}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Skills and memory"
          description="Your computer uses the same skills and memory as your agents in Kriya. Notes it saves wait for you to confirm."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {studio && (
              <Link
                href="/agents/skills"
                className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4 py-2.5"
              >
                <WandSparklesIcon className="size-4 shrink-0 text-rigel" />
                <span className="flex-1 text-[13.5px] font-medium">Skill Studio</span>
                <ChevronRightIcon className="size-4 text-faint" />
              </Link>
            )}
            <Link
              href={memoryV2 ? "/account#about-you" : "/agents"}
              className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4 py-2.5"
            >
              <BrainIcon className="size-4 shrink-0 text-rigel" />
              <span className="flex-1 text-[13.5px] font-medium">
                {memoryV2 ? "What your agents know" : "Your agents"}
              </span>
              <ChevronRightIcon className="size-4 text-faint" />
            </Link>
          </div>
        </Section>

        <p className="text-[11.5px] text-faint">
          Built on DeepSeek Harness.
          {beta && " Beta: check what an agent proposes before you approve it."}
        </p>
      </div>
    </div>
  )
}
