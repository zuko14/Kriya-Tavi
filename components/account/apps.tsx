"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { disconnectApp, enableApp } from "@/actions/apps"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import type { AppView } from "@/queries/apps"

// Account → Apps (N6, UX_SPEC §3), after Connected accounts: the apps the
// owner offers, which the person has connected, and which agents may use
// each. "Apps", never "MCP". Connecting is a plain GET form: the server route
// does the sign-in hand-off.

type Agent = { id: string; name: string }

function who(app: AppView, agents: Agent[]) {
  if (app.enabled === "all") return "All your agents"
  const names = agents.filter((a) => app.enabled.includes(a.id)).map((a) => a.name)
  return names.length > 0 ? names.join(", ") : "None yet"
}

// "All my agents", or a checklist; each row is a 44 px target
function ChooseAgents({ app, agents }: { app: AppView; agents: Agent[] }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [all, setAll] = React.useState(app.enabled === "all")
  const [picked, setPicked] = React.useState<string[]>(
    app.enabled === "all" ? [] : app.enabled
  )
  // Start from what's saved each time it opens
  const openIt = () => {
    setAll(app.enabled === "all")
    setPicked(app.enabled === "all" ? [] : app.enabled)
    setOpen(true)
  }

  const row =
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2"
  const save = async () => {
    setBusy(true)
    const result = await enableApp(app.id, all ? "all" : picked).catch(() => ({
      error: "That didn't go through. Try again.",
    }))
    setBusy(false)
    if ("error" in result) {
      toast.add({
        type: "error",
        title: `Couldn't change ${app.name}`,
        description: result.error,
      })
      return
    }
    setOpen(false)
    router.refresh()
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 sm:h-9"
        aria-label={`Change which agents use ${app.name}`}
        onClick={openIt}
      >
        Change
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Who can use {app.name}?</DialogTitle>
            <DialogDescription>
              Agents you don&apos;t choose can&apos;t see {app.name}. Anything that
              changes something there still waits for your OK.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 px-5 pb-2">
            <label className={row}>
              <Checkbox checked={all} onCheckedChange={(v) => setAll(Boolean(v))} />
              <span className="text-[13px] font-medium">All my agents</span>
            </label>
            {agents.map((agent) => (
              <label key={agent.id} className={row}>
                <Checkbox
                  checked={all || picked.includes(agent.id)}
                  disabled={all}
                  onCheckedChange={(v) =>
                    setPicked((now) =>
                      v ? [...now, agent.id] : now.filter((id) => id !== agent.id)
                    )
                  }
                />
                <span className="text-[13px]">{agent.name}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" className="h-11 sm:h-9" />}
            >
              Cancel
            </DialogClose>
            <Button
              type="button"
              className="h-11 sm:h-9"
              disabled={busy || (!all && picked.length === 0)}
              onClick={save}
            >
              {busy && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Connect({ app, label }: { app: AppView; label: string }) {
  return (
    <form action={`/api/connect/mcp/${app.id}`} method="get">
      <Button
        type="submit"
        variant={app.connected ? "outline" : "default"}
        className="h-11 sm:h-9"
        aria-label={`${label} ${app.name}`}
      >
        {label}
      </Button>
    </form>
  )
}

function AppCard({ app, agents }: { app: AppView; agents: Agent[] }) {
  const router = useRouter()
  return (
    <div className="flex flex-col gap-4 rounded-2xl border bg-surface/60 p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[14.5px] font-semibold">
          {app.name}{" "}
          <span className="font-normal text-muted-foreground">· {app.domain}</span>
        </span>
        {app.reads.length > 0 && (
          <span className="text-[12.5px] break-words text-muted-foreground">
            Reads: {app.reads.join(", ")}
          </span>
        )}
        {app.asks.length > 0 && (
          <span className="text-[12.5px] break-words text-muted-foreground">
            Asks you first: {app.asks.join(", ")}
          </span>
        )}
        <span className="text-[12.5px] text-muted-foreground">
          Uses your {app.name} account
        </span>
      </div>

      {app.paused && <p className="text-[12.5px] text-betelgeuse">Paused by Kriya</p>}
      {app.connected && (
        <p className="text-[12.5px]">
          <span className="font-medium">Connected ✓</span>
          <span className="text-muted-foreground"> · Used by: {who(app, agents)}</span>
        </p>
      )}
      {app.connected && app.needsReconnect && !app.paused && (
        <p role="status" className="text-[12.5px] text-betelgeuse">
          {app.name} stopped working. Reconnect to keep your agents&apos; access.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!app.connected && !app.paused && <Connect app={app} label="Connect" />}
        {app.connected && !app.paused && app.needsReconnect && (
          <Connect app={app} label="Reconnect" />
        )}
        {app.connected && !app.paused && <ChooseAgents app={app} agents={agents} />}
        {app.connected && (
          <Confirm
            trigger={
              <Button
                type="button"
                variant="outline"
                className="h-11 sm:h-9"
                aria-label={`Disconnect ${app.name}`}
              >
                Disconnect
              </Button>
            }
            title={`Disconnect ${app.name}?`}
            description={`Your agents lose access right away and Kriya forgets the keys. Anything already done in ${app.name} stays there.`}
            action="Disconnect"
            onConfirm={async () => {
              await disconnectApp(app.id)
              toast.add({ type: "success", title: `${app.name} disconnected` })
              router.refresh()
            }}
          />
        )}
      </div>
    </div>
  )
}

export function Apps({ apps, agents }: { apps: AppView[]; agents: Agent[] }) {
  if (apps.length === 0)
    return <p className="text-[13px] text-muted-foreground">No apps are available yet.</p>
  return (
    <div className="flex flex-col gap-3">
      {apps.map((app) => (
        <AppCard key={app.id} app={app} agents={agents} />
      ))}
    </div>
  )
}
