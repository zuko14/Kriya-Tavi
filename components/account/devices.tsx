"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { renameDevice, revokeDevice, setDeviceMirror } from "@/actions/harness"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { formatInr } from "@/lib/money"
import { cn } from "@/lib/utils"
import type { DeviceRow } from "@/queries/harness"

// Account → Devices (track H, UX_SPEC §1): computers signed in to Kriya
// Harness. The person renames or revokes them; a revoked device signs out on
// its next request. H6: the session mirror's mode, while it's available.

const PLATFORMS = { darwin: "macOS", linux: "Linux", win32: "Windows" } as const

const MIRROR = {
  off: "Mirror off: nothing from this device's sessions comes to Kriya.",
  summary: "Mirror summaries: each turn's text and the tools it used appear in a thread.",
  full: "Mirror full: everything, tool details included, appears in a thread.",
} as const

const MIRROR_CHOICES = [
  { id: "off", label: "Off" },
  { id: "summary", label: "Summaries" },
  { id: "full", label: "Full" },
] as const

const DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})

export function Devices({ devices }: { devices: DeviceRow[] }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState<DeviceRow | null>(null)
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  if (devices.length === 0)
    return (
      <p className="text-[13px] text-muted-foreground">
        No devices yet. Install Kriya Harness on a computer and run{" "}
        <code className="font-mono text-[12.5px]">kriya login</code>.
      </p>
    )

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
      <ul className="flex flex-col divide-y rounded-xl border">
        {devices.map((device) => (
          <li key={device.id} className="flex flex-col gap-2 px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[14px] font-medium">{device.name}</span>
              <span className="text-[12.5px] text-muted-foreground">
                {PLATFORMS[device.platform]}
                {device.clientVersion && ` · version ${device.clientVersion}`}
                {device.agentName && ` · works as ${device.agentName}`}
              </span>
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              Last used {DATE.format(new Date(device.lastUsedAt))} ·{" "}
              {formatInr(device.spentMicroInr)} this month
            </p>
            {device.mirrorAvailable && (
              <div
                role="radiogroup"
                aria-label={`Session mirror for ${device.name}`}
                className="grid grid-cols-3 gap-1.5 sm:max-w-sm"
              >
                {MIRROR_CHOICES.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    role="radio"
                    aria-checked={device.mirror === choice.id}
                    disabled={busy}
                    onClick={async () => {
                      if (device.mirror === choice.id) return
                      setError(null)
                      setBusy(true)
                      const result = await setDeviceMirror(device.id, choice.id)
                      setBusy(false)
                      if ("error" in result) setError(result.error ?? null)
                      else router.refresh()
                    }}
                    className={cn(
                      "min-h-11 rounded-lg border px-2 text-[12.5px] font-medium transition-colors sm:min-h-8",
                      device.mirror === choice.id
                        ? "border-rigel bg-rigel-soft text-rigel"
                        : "text-muted-foreground hover:bg-accent/40"
                    )}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[12.5px] text-muted-foreground">{MIRROR[device.mirror]}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="min-h-11 sm:min-h-8"
                onClick={() => {
                  setRenaming(device)
                  setName(device.name)
                }}
              >
                Rename
              </Button>
              <Confirm
                trigger={
                  <Button
                    variant="outline"
                    className="min-h-11 text-destructive sm:min-h-8"
                  >
                    Revoke
                  </Button>
                }
                title={`Revoke ${device.name}?`}
                description="This device signs out immediately. Run kriya login on it to sign in again."
                action="Revoke"
                onConfirm={async () => {
                  setError(null)
                  const result = await revokeDevice(device.id)
                  if ("error" in result) setError(result.error ?? null)
                  else router.refresh()
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!renaming) return
              setBusy(true)
              const result = await renameDevice(renaming.id, name)
              setBusy(false)
              if ("error" in result) setError(result.error ?? null)
              else {
                setRenaming(null)
                router.refresh()
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename device</DialogTitle>
              <DialogDescription>Only you see this name.</DialogDescription>
            </DialogHeader>
            <Input
              value={name}
              maxLength={60}
              required
              aria-label="Device name"
              onChange={(event) => setName(event.target.value)}
              className="min-h-11"
            />
            <DialogFooter>
              <Button type="submit" className="min-h-11" disabled={busy || !name.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
