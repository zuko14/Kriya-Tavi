"use client"

import * as React from "react"
import {
  CalendarIcon,
  CameraIcon,
  FileTextIcon,
  GitBranchIcon,
  MailIcon,
  NotebookTextIcon,
  PlayIcon,
  Share2Icon,
  SheetIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"

import { disconnectAccount } from "@/actions/connections"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"

const GOOGLE = [
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarIcon,
    detail: "See your schedule; add events after you approve each one",
  },
  {
    id: "gmail",
    label: "Gmail",
    icon: MailIcon,
    detail: "Search and read mail; save drafts after you approve. Never sends.",
  },
  {
    id: "drive",
    label: "Drive",
    icon: FileTextIcon,
    detail: "Search and read Docs, Sheets and Slides. Read-only.",
  },
] as const

// G2 (operator.driveShare): opt-in, never ticked for you; a Restricted scope
const DRIVE_SHARE = {
  id: "drive_share",
  label: "Drive sharing",
  icon: Share2Icon,
  detail:
    "Share a Drive file with people, after you approve each share. Google emails them.",
} as const

// A8: opt-in, never ticked for you
const GOOGLE_MORE = [
  {
    id: "sheets",
    label: "Sheets",
    icon: SheetIcon,
    detail: "Read sheets; add or change rows after you approve each change",
  },
  {
    id: "youtube",
    label: "YouTube",
    icon: PlayIcon,
    detail: "See your channel's views and subscribers. Read-only.",
  },
] as const

type Account = { account: string | null } | null

export type ConnectionView = {
  google: { account: string | null; services: string[] } | null
  notion: Account
  available: { google: boolean; notion: boolean }
  // Only with agents.connectors on (A8)
  more?: { github: Account; meta: Account; available: { github: boolean; meta: boolean } }
  // G1: derived from the person's tool runs (queries/connections.ts)
  health?: Partial<Record<string, "ok" | "needs_reconnect">>
  // G1: google.testingMode, the Google app's refresh tokens last 7 days
  testingMode?: boolean
  // G2: offer the "Drive sharing" box (operator.driveShare, with `more`)
  driveShare?: boolean
}

const STOPPED = (name: string) =>
  `${name} stopped working. Reconnect to keep your agents' access.`

function Disconnect({ provider, name }: { provider: string; name: string }) {
  const router = useRouter()
  return (
    <Confirm
      trigger={
        <Button type="button" variant="outline" className="h-11 sm:h-9">
          Disconnect
        </Button>
      }
      title={`Disconnect ${name}?`}
      description={`Your agents lose access right away and Kriya forgets the keys. Events and drafts already made stay in ${name}.`}
      action="Disconnect"
      onConfirm={async () => {
        await disconnectAccount(provider)
        toast.add({ type: "success", title: `${name} disconnected` })
        router.refresh()
      }}
    />
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border bg-surface/60 p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[14.5px] font-semibold">{title}</span>
        <span className="text-[12.5px] break-words text-muted-foreground">
          {subtitle}
        </span>
      </div>
      {children}
    </div>
  )
}

// GitHub and Instagram: one button, like Notion
function Simple({
  provider,
  name,
  icon: Icon,
  connected,
  available,
  subtitle,
  again,
  stopped,
}: {
  provider: string
  name: string
  icon: typeof GitBranchIcon
  connected: Account
  available: boolean
  subtitle: string
  again: string
  stopped?: boolean
}) {
  return (
    <Card
      title={name}
      subtitle={
        connected && stopped
          ? STOPPED(name)
          : available || connected
            ? subtitle
            : "Not available on this server yet."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <form action={`/api/connect/${provider}`} method="get">
          <Button
            type="submit"
            variant={connected ? "outline" : "default"}
            className="h-11 sm:h-9"
            disabled={!available}
          >
            {connected ? (stopped ? `Reconnect ${name}` : again) : `Connect ${name}`}
          </Button>
        </form>
        {connected && <Disconnect provider={provider} name={name} />}
      </div>
    </Card>
  )
}

// Connecting is a plain GET form: the server route does the OAuth hand-off
export function Connections({
  google,
  notion,
  available,
  more,
  health = {},
  testingMode = false,
  driveShare = false,
}: ConnectionView) {
  const services = [
    ...GOOGLE,
    ...(more ? GOOGLE_MORE : []),
    ...(more && driveShare ? [DRIVE_SHARE] : []),
  ]
  const stopped = (provider: string) => health[provider] === "needs_reconnect"
  return (
    <div className="flex flex-col gap-3">
      <Card
        title="Google"
        subtitle={
          google && stopped("google")
            ? STOPPED("Google")
            : google
              ? `Connected as ${google.account ?? "your Google account"}`
              : available.google
                ? "Pick what your agents may use. You can change it any time."
                : "Not available on this server yet."
        }
      >
        <form action="/api/connect/google" method="get" className="flex flex-col gap-3">
          <fieldset
            className="flex flex-col divide-y rounded-xl border bg-background/50"
            disabled={!available.google}
          >
            <legend className="sr-only">Google services</legend>
            {services.map(({ id, label, icon: Icon, detail }) => (
              <label
                key={id}
                className="flex min-h-14 cursor-pointer items-center gap-3 px-3.5 py-2.5 has-disabled:cursor-not-allowed has-disabled:opacity-60"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="text-[13.5px] font-medium">{label}</span>
                  <span className="text-[12px] text-muted-foreground">{detail}</span>
                </span>
                <input
                  type="checkbox"
                  name="service"
                  value={id}
                  defaultChecked={
                    google
                      ? google.services.includes(id)
                      : !GOOGLE_MORE.some((extra) => extra.id === id) &&
                        id !== DRIVE_SHARE.id
                  }
                  className="size-5 shrink-0 accent-(--rigel)"
                />
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="h-11 sm:h-9" disabled={!available.google}>
              {google
                ? stopped("google")
                  ? "Reconnect Google"
                  : "Update access"
                : "Connect Google"}
            </Button>
            {google && <Disconnect provider="google" name="Google" />}
          </div>
          {testingMode && (available.google || google) && (
            <p className="text-[12.5px] text-muted-foreground">
              Kriya&apos;s Google access is in testing: Google asks you to reconnect every
              7 days during the pilot.
            </p>
          )}
        </form>
      </Card>

      <Card
        title="Notion"
        subtitle={
          notion && stopped("notion")
            ? STOPPED("Notion")
            : notion
              ? `Connected to ${notion.account ?? "your workspace"}`
              : available.notion
                ? "Your agents can search and read the pages you choose to share. Read-only."
                : "Not available on this server yet."
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <NotebookTextIcon className="size-4 text-muted-foreground" />
          <form action="/api/connect/notion" method="get">
            <Button
              type="submit"
              variant={notion ? "outline" : "default"}
              className="h-11 sm:h-9"
              disabled={!available.notion}
            >
              {notion
                ? stopped("notion")
                  ? "Reconnect Notion"
                  : "Choose pages again"
                : "Connect Notion"}
            </Button>
          </form>
          {notion && <Disconnect provider="notion" name="Notion" />}
        </div>
      </Card>

      {more && (
        <>
          <Simple
            provider="github"
            name="GitHub"
            icon={GitBranchIcon}
            connected={more.github}
            available={more.available.github}
            subtitle={
              more.github
                ? `Connected as ${more.github.account ?? "your GitHub account"}`
                : "Install Kriya's GitHub app on the repositories you choose. Agents read issues and pull requests; comments, issues, labels and pull requests wait for your approval."
            }
            again="Choose repositories again"
            stopped={stopped("github")}
          />
          <Simple
            provider="meta"
            name="Instagram"
            icon={CameraIcon}
            connected={more.meta}
            available={more.available.meta}
            subtitle={
              more.meta
                ? `Connected as ${more.meta.account ? `@${more.meta.account}` : "your professional account"}`
                : "For professional accounts linked to a Facebook Page. Agents see followers and post numbers; each post waits for your approval."
            }
            again="Reconnect"
            stopped={stopped("meta")}
          />
        </>
      )}
    </div>
  )
}
