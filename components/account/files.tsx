"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { confirmUpload, createUploadUrl, deleteFile } from "@/actions/files"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { FileListItem } from "@/lib/files"

// Account → Files (A5, UX_SPEC §8): upload (camera on phones), status
// chips, search, delete. The bytes go straight to the private bucket
// through a signed link; the server then checks what arrived.

const ACCEPT =
  "image/*,application/pdf,text/csv,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Uploading", tone: "text-faint" },
  ready: { label: "Reading", tone: "text-faint" },
  extracted: { label: "Ready", tone: "text-ok" },
  rejected: { label: "Couldn't read", tone: "text-destructive" },
  failed: { label: "Couldn't read", tone: "text-destructive" },
}

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" })

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-IN")} KB`
    : `${(bytes / 1048576).toLocaleString("en-IN", { maximumFractionDigits: 1 })} MB`

export function Files({ files }: { files: FileListItem[] }) {
  const router = useRouter()
  const [query, setQuery] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const input = React.useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    setBusy(true)
    setMessage(null)
    try {
      const created = await createUploadUrl(file.name, file.type, file.size)
      if (!("uploadUrl" in created) || !created.uploadUrl) {
        return setMessage(
          ("error" in created && created.error) || "Couldn't upload that."
        )
      }
      const sent = await fetch(created.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type, "x-upsert": "false" },
        body: file,
      })
      if (!sent.ok) return setMessage("The upload didn't go through. Try again.")
      const checked = await confirmUpload(created.fileId!)
      if ("error" in checked && checked.error) setMessage(checked.error)
      else if ("reason" in checked && checked.reason) setMessage(checked.reason)
      router.refresh()
    } catch {
      setMessage("The upload didn't go through. Try again.")
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ""
    }
  }

  const shown = files.filter((f) =>
    f.name.toLowerCase().includes(query.trim().toLowerCase())
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          capture="environment"
          className="sr-only"
          id="file-upload"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
          }}
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-11 sm:min-h-8"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Uploading…" : "Upload a file"}
        </Button>
        {files.length > 5 && (
          <Input
            type="search"
            placeholder="Search files"
            aria-label="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-h-11 max-w-56 sm:min-h-8"
          />
        )}
      </div>
      {message && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {message}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {files.length
            ? "No file matches that."
            : "No files yet. PDFs, photos, CSV, text and Word files up to your plan's size."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {shown.map((f) => {
            const status = STATUS[f.status]
            const openable = ["ready", "extracted", "failed"].includes(f.status)
            return (
              <li
                key={f.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  {openable ? (
                    <a
                      href={`/api/files/${f.id}`}
                      className="truncate text-[13.5px] hover:underline"
                    >
                      {f.name}
                    </a>
                  ) : (
                    <span className="truncate text-[13.5px]">{f.name}</span>
                  )}
                  <span className="font-mono text-[10.5px] text-faint">
                    {size(f.sizeBytes)} · {DATE.format(new Date(f.createdAt))}
                    {f.origin === "generated" && " · Made by Kriya"}
                  </span>
                </div>
                {f.origin !== "generated" && (
                  <span className={`font-mono text-[10.5px] ${status.tone}`}>
                    {status.label}
                  </span>
                )}
                <Confirm
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="min-h-11 sm:min-h-6"
                    >
                      Delete
                    </Button>
                  }
                  title="Delete this file?"
                  description={`“${f.name}” and anything read from it are deleted. A link you shared from it stops working.`}
                  action="Delete"
                  onConfirm={async () => {
                    const result = await deleteFile(f.id)
                    if ("error" in result && result.error) setMessage(result.error)
                    router.refresh()
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
