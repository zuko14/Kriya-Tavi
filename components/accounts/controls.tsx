"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { confirmEntries, issueInvoice, setInvoiceStatus } from "@/actions/ledger"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

// The person's actions in Accounts (A7): confirming entries, issuing and
// closing invoices. None of these is an agent tool (DATA_MODEL §3.5).

const tap = "min-h-11 sm:min-h-8"

function useAction() {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const run = (work: () => Promise<{ error?: string } | object>) =>
    start(async () => {
      setError(null)
      const result = await work().catch(() => ({
        error: "That didn't go through. Try again.",
      }))
      if ("error" in result && result.error) setError(result.error)
      router.refresh()
    })
  return { pending, error, run }
}

const Alert = ({ error }: { error: string | null }) =>
  error ? (
    <span role="alert" className="text-[12px] text-destructive">
      {error}
    </span>
  ) : null

export function ConfirmDrafts({ ids }: { ids: string[] }) {
  const { pending, error, run } = useAction()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Confirm
        trigger={
          <Button size="sm" className={tap} disabled={pending}>
            Confirm all {ids.length}
          </Button>
        }
        title={`Confirm ${ids.length} ${ids.length === 1 ? "entry" : "entries"}?`}
        description="Confirmed entries count in your summaries and exports. You can void one later, but not change it."
        action="Confirm"
        onConfirm={() => run(() => confirmEntries(ids))}
      />
      <Alert error={error} />
    </div>
  )
}

// An entry that needed review is confirmed only with the person's note
export function ConfirmWithNote({ id }: { id: string }) {
  const { pending, error, run } = useAction()
  const [open, setOpen] = React.useState(false)
  const [note, setNote] = React.useState("")
  if (!open) {
    return (
      <Button size="xs" variant="outline" className={tap} onClick={() => setOpen(true)}>
        Confirm with a note
      </Button>
    )
  }
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        run(() => confirmEntries([id], note))
      }}
    >
      <Textarea
        aria-label="Why it's right"
        placeholder="Why it's right, e.g. checked the paper bill"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="min-h-16 text-[13px]"
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          size="xs"
          className={tap}
          disabled={pending || !note.trim()}
        >
          Confirm
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className={tap}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      <Alert error={error} />
    </form>
  )
}

export function InvoiceActions({
  id,
  status,
  pdfFileId,
}: {
  id: string
  status: string
  pdfFileId: string | null
}) {
  const { pending, error, run } = useAction()
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "draft" && (
        <Confirm
          trigger={
            <Button size="xs" className={tap} disabled={pending}>
              Issue
            </Button>
          }
          title="Issue this invoice?"
          description="It gets the next number in your series for this financial year, permanently. An issued invoice can't be edited or deleted, only voided."
          action="Issue"
          onConfirm={() => run(() => issueInvoice(id))}
        />
      )}
      {pdfFileId && (
        <a
          href={`/api/files/${pdfFileId}`}
          className={`${tap} inline-flex items-center rounded-md border px-2.5 text-[12px] hover:bg-muted`}
        >
          PDF
        </a>
      )}
      {status === "issued" && (
        <>
          <Button
            size="xs"
            variant="outline"
            className={tap}
            disabled={pending}
            onClick={() => run(() => setInvoiceStatus(id, "paid"))}
          >
            Mark paid
          </Button>
          <Confirm
            trigger={
              <Button size="xs" variant="ghost" className={tap} disabled={pending}>
                Void
              </Button>
            }
            title="Void this invoice?"
            description="It keeps its number, which isn't used again, and its income entry is voided too."
            action="Void"
            onConfirm={() => run(() => setInvoiceStatus(id, "void"))}
          />
        </>
      )}
      <Alert error={error} />
    </div>
  )
}
