"use client"

import * as React from "react"
import { CalendarIcon, FileTextIcon, MailIcon, NotebookTextIcon } from "lucide-react"
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

export type ConnectionView = {
  google: { account: string | null; services: string[] } | null
  notion: { account: string | null } | null
  available: { google: boolean; notion: boolean }
}

function Disconnect({ provider, name }: { provider: "google" | "notion"; name: string }) {
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

// Connecting is a plain GET form: the server route does the OAuth hand-off
export function Connections({ google, notion, available }: ConnectionView) {
  return (
    <div className="flex flex-col gap-3">
      <Card
        title="Google"
        subtitle={
          google
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
            {GOOGLE.map(({ id, label, icon: Icon, detail }) => (
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
                  defaultChecked={google ? google.services.includes(id) : true}
                  className="size-5 shrink-0 accent-(--rigel)"
                />
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="h-11 sm:h-9" disabled={!available.google}>
              {google ? "Update access" : "Connect Google"}
            </Button>
            {google && <Disconnect provider="google" name="Google" />}
          </div>
        </form>
      </Card>

      <Card
        title="Notion"
        subtitle={
          notion
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
              {notion ? "Choose pages again" : "Connect Notion"}
            </Button>
          </form>
          {notion && <Disconnect provider="notion" name="Notion" />}
        </div>
      </Card>
    </div>
  )
}
