"use client"

import * as React from "react"

import { createShare, receiptPdf } from "@/actions/share"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// On a receipt (K1, K8): Download PDF, and Share, which asks how long,
// names exactly what's shared, and shows the link once.

const tap = "min-h-11 sm:min-h-6"
const DAYS = [1, 3, 7, 14, 30]

export function ReceiptActions({ episodeId, seq }: { episodeId: string; seq: number }) {
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [days, setDays] = React.useState(7)
  const [link, setLink] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  const download = () =>
    start(async () => {
      setError(null)
      const result = await receiptPdf(episodeId).catch(() => ({
        error: "That didn't work. Try again.",
      }))
      if ("href" in result && result.href) window.location.assign(result.href)
      else setError(("error" in result && result.error) || "That didn't work.")
    })

  const share = () =>
    start(async () => {
      setError(null)
      const result = await createShare("receipt", episodeId, days).catch(() => ({
        error: "That didn't work. Try again.",
      }))
      if ("path" in result && result.path)
        setLink(`${window.location.origin}${result.path}`)
      else setError(("error" in result && result.error) || "That didn't work.")
    })

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        className={tap}
        disabled={pending}
        onClick={download}
      >
        Download PDF
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className={tap}
        disabled={pending}
        onClick={() => {
          setLink(null)
          setCopied(false)
          setError(null)
          setOpen(true)
        }}
      >
        Share
      </Button>
      {error && !open && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{link ? "Your link" : `Share receipt #${seq}?`}</DialogTitle>
            <DialogDescription>
              {link
                ? "Copy it now: Kriya keeps only a fingerprint of it, so it can't be shown again."
                : `Anyone with the link can open a read-only PDF of receipt #${seq}: the checked actions with their evidence, the not-confirmed lines, the charge and the record hash. Nothing else from your account. You can revoke it in Account → Shared links.`}
            </DialogDescription>
          </DialogHeader>
          {link ? (
            <div className="flex flex-col gap-2">
              <code className="rounded-md border px-2 py-1.5 font-code text-[11px] break-all">
                {link}
              </code>
              <Button
                className="min-h-11 sm:min-h-8"
                onClick={async () => {
                  await navigator.clipboard.writeText(link).then(
                    () => setCopied(true),
                    () => setCopied(false)
                  )
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-[13px]">
              Expires after
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="min-h-11 rounded-md border bg-transparent px-2 sm:min-h-8"
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "1 day" : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && open && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
          {!link && (
            <DialogFooter>
              <Button className="min-h-11 sm:min-h-8" disabled={pending} onClick={share}>
                {pending
                  ? "Making the snapshot…"
                  : `Share for ${days === 1 ? "1 day" : `${days} days`}`}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
