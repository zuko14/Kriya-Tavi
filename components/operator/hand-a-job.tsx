"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BriefcaseIcon, ChevronRightIcon } from "lucide-react"

import { proposeFromPlaybook } from "@/actions/mandates"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { SlotKind } from "@/lib/operator/playbooks"

// "Hand Kriya a job" on Home (O7, UX_SPEC §4): the playbooks the person can
// actually run, each opening a short form for its slots. Submitting makes
// the same job card an agent's proposal would, in the Inbox, where the
// person approves it.

export type PlaybookChoice = {
  id: string
  title: string
  summary: string
  slots: { kind: SlotKind; label: string; optional?: boolean; hint?: string }[]
}

const tap = "min-h-11"
const field = "flex flex-col gap-1.5"
// One address per line or comma; the server checks each one
const emailsOf = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean)

function SlotForm({
  playbook,
  agents,
  invoices,
}: {
  playbook: PlaybookChoice
  agents: { id: string; name: string }[]
  invoices: { id: string; label: string }[]
}) {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const [agentId, setAgentId] = React.useState(agents[0]?.id ?? "")
  const [picked, setPicked] = React.useState<string[]>([])
  const [emails, setEmails] = React.useState("")
  const [text, setText] = React.useState("")
  const [month, setMonth] = React.useState("")
  const [sheet, setSheet] = React.useState({ spreadsheetId: "", range: "" })

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const kinds = new Set(playbook.slots.map((s) => s.kind))
    const slots = {
      ...(kinds.has("invoices") && { invoices: picked }),
      ...(kinds.has("emails") && emailsOf(emails).length && { emails: emailsOf(emails) }),
      ...(kinds.has("text") && text.trim() && { text: text.trim() }),
      ...(kinds.has("date") && month && { date: month }),
      ...(kinds.has("sheet") &&
        sheet.spreadsheetId.trim() && {
          sheet: { spreadsheetId: sheet.spreadsheetId.trim(), range: sheet.range.trim() },
        }),
    }
    start(async () => {
      setError(null)
      try {
        const result = await proposeFromPlaybook(playbook.id, slots, agentId)
        if ("error" in result) setError(result.error)
        else router.push("/inbox")
      } catch {
        setError("That didn't go through. Try again.")
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {agents.length > 1 && (
        <div className={field}>
          <Label htmlFor="job-agent">Agent</Label>
          <select
            id="job-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="min-h-11 rounded-md border bg-background px-3 text-[14px]"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {playbook.slots.map((slot) => {
        const label = slot.label
        switch (slot.kind) {
          case "invoices":
            return (
              <fieldset key={slot.kind} className={field}>
                <legend className="mb-1.5 text-[13px] font-medium">{label}</legend>
                {invoices.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    No issued invoices are past their due date.
                  </p>
                ) : (
                  invoices.slice(0, 10).map((invoice) => (
                    <label
                      key={invoice.id}
                      className="flex min-h-11 items-center gap-3 text-[13.5px]"
                    >
                      <input
                        type="checkbox"
                        className="size-5"
                        checked={picked.includes(invoice.id)}
                        onChange={(e) =>
                          setPicked(
                            e.target.checked
                              ? [...picked, invoice.id]
                              : picked.filter((id) => id !== invoice.id)
                          )
                        }
                      />
                      {invoice.label}
                    </label>
                  ))
                )}
              </fieldset>
            )
          case "emails":
            return (
              <div key={slot.kind} className={field}>
                <Label htmlFor="job-emails">{label}</Label>
                <Textarea
                  id="job-emails"
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="asha@example.com, ravi@example.com"
                  rows={2}
                />
                {slot.hint && (
                  <span className="text-[12px] text-muted-foreground">{slot.hint}</span>
                )}
              </div>
            )
          case "text":
            return (
              <div key={slot.kind} className={field}>
                <Label htmlFor="job-text">{label}</Label>
                <Textarea
                  id="job-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={1000}
                  rows={3}
                />
              </div>
            )
          case "date":
            return (
              <div key={slot.kind} className={field}>
                <Label htmlFor="job-month">{label}</Label>
                <Input
                  id="job-month"
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className={tap}
                />
              </div>
            )
          case "sheet":
            return (
              <fieldset key={slot.kind} className={field}>
                <legend className="mb-1.5 text-[13px] font-medium">{label}</legend>
                <Label htmlFor="job-sheet-id" className="sr-only">
                  Spreadsheet id
                </Label>
                <Input
                  id="job-sheet-id"
                  placeholder="Spreadsheet id (from its link)"
                  value={sheet.spreadsheetId}
                  onChange={(e) => setSheet({ ...sheet, spreadsheetId: e.target.value })}
                  className={tap}
                />
                <Label htmlFor="job-sheet-range" className="sr-only">
                  Range
                </Label>
                <Input
                  id="job-sheet-range"
                  placeholder="Range, e.g. Prices!A1"
                  value={sheet.range}
                  onChange={(e) => setSheet({ ...sheet, range: e.target.value })}
                  className={tap}
                />
              </fieldset>
            )
        }
      })}
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className={tap} disabled={pending || !agentId}>
        Propose the job
      </Button>
      <p className="text-[12px] text-muted-foreground">
        Nothing starts yet: you review the job card in your Inbox and approve it there.
      </p>
    </form>
  )
}

export function HandAJob({
  playbooks,
  agents,
  invoices,
}: {
  playbooks: PlaybookChoice[]
  agents: { id: string; name: string }[]
  invoices: { id: string; label: string }[]
}) {
  const [open, setOpen] = React.useState<PlaybookChoice | null>(null)
  return (
    <>
      <ul className="flex flex-col gap-2">
        {playbooks.map((playbook) => (
          <li key={playbook.id}>
            <button
              type="button"
              onClick={() => setOpen(playbook)}
              className="glass flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left"
            >
              <BriefcaseIcon className="size-4 shrink-0 text-rigel" />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="text-[13.5px] font-medium">{playbook.title}</span>
                <span className="text-[12px] text-muted-foreground">
                  {playbook.summary}
                </span>
              </span>
              <ChevronRightIcon className="size-4 text-faint" />
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{open.title}</DialogTitle>
                <DialogDescription>{open.summary}</DialogDescription>
              </DialogHeader>
              <SlotForm playbook={open} agents={agents} invoices={invoices} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
