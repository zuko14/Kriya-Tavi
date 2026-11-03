"use client"

import * as React from "react"
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FileTextIcon,
  ImageIcon,
  Loader2Icon,
  MicIcon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"

import { confirmUpload, createUploadUrl } from "@/actions/files"

import { Glyph } from "@/components/glyph"
import { TierLabel } from "@/components/model-picker"
import { useDictation } from "@/components/thread/dictation"
import type { AgentLite } from "@/components/thread/transcript"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"

// A file attached to the next message: uploaded to the person's Kriya files
// (the same checked flow as Account → Files), then sent by id
export type Attachment = { id: string; name: string; mime: string }
type Pending = Attachment & { key: string; state: "uploading" | "ready" }

// Matches FILE_MIMES (db/schema.ts) and the account page
const ACCEPT =
  "image/png,image/jpeg,image/webp,application/pdf,text/csv,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MAX_FILES = 5

export function Composer({
  placeholder,
  busy,
  disabled,
  onSend,
  onStop,
  members,
  addressee,
  onAddresseeChange,
  tier,
  draftKey,
  leading,
  autoFocus = true,
  attach = false,
}: {
  placeholder: string
  busy: boolean
  disabled?: boolean
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  members?: AgentLite[]
  addressee?: AgentLite
  onAddresseeChange?: (agentId: string) => void
  // The routing tier of whoever the message goes to
  tier: string | null
  draftKey: string
  // Replaces the squad addressee picker, e.g. the home screen's agent picker
  leading?: React.ReactNode
  autoFocus?: boolean
  // Files can be attached (agents.files)
  attach?: boolean
}) {
  const [text, setText] = React.useState("")
  const [files, setFiles] = React.useState<Pending[]>([])
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const picker = React.useRef<HTMLInputElement>(null)
  const uploading = files.some((f) => f.state === "uploading")

  async function upload(file: File) {
    const key = `${file.name}:${file.size}:${Math.random()}`
    setFiles((now) => [
      ...now,
      { key, id: "", name: file.name, mime: file.type, state: "uploading" },
    ])
    const drop = (message: string) => {
      setFiles((now) => now.filter((f) => f.key !== key))
      toast.add({ type: "error", title: `${file.name}: ${message}` })
    }
    try {
      const created = await createUploadUrl(file.name, file.type, file.size)
      if (!("uploadUrl" in created) || !created.uploadUrl || !created.fileId)
        return drop(("error" in created && created.error) || "couldn't upload it.")
      const sent = await fetch(created.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type, "x-upsert": "false" },
        body: file,
      })
      if (!sent.ok) return drop("the upload didn't go through. Try again.")
      const checked = await confirmUpload(created.fileId)
      if (!("status" in checked)) return drop(checked.error)
      if (checked.status !== "ready" && checked.status !== "extracted")
        return drop(("reason" in checked && checked.reason) || "Kriya can't read it.")
      setFiles((now) =>
        now.map((f) =>
          f.key === key ? { ...f, id: created.fileId!, state: "ready" } : f
        )
      )
    } catch {
      drop("the upload didn't go through. Try again.")
    }
  }

  const pick = (list: FileList | null) => {
    const room = MAX_FILES - files.length
    const chosen = Array.from(list ?? [])
    if (chosen.length > room)
      toast.add({
        type: "error",
        title: `Attach at most ${MAX_FILES} files to one message.`,
      })
    for (const file of chosen.slice(0, Math.max(0, room))) void upload(file)
    if (picker.current) picker.current.value = ""
  }

  // Unsent drafts survive navigation between threads
  React.useEffect(() => {
    try {
      // Restoring from browser storage is exactly what effects are for
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(sessionStorage.getItem(`kriya:draft:${draftKey}`) ?? "")
    } catch {}
    // Phones open the keyboard on focus, which hides the screen it's on
    if (autoFocus) ref.current?.focus()
  }, [draftKey, autoFocus])

  React.useEffect(() => {
    try {
      if (text) sessionStorage.setItem(`kriya:draft:${draftKey}`, text)
      else sessionStorage.removeItem(`kriya:draft:${draftKey}`)
    } catch {}
  }, [text, draftKey])

  // Voice typing: what was in the box before speaking, then the words
  // heard so far. Null once the text has been sent, so late results from
  // the recogniser don't bring it back.
  const spokenAfter = React.useRef<string | null>(null)
  const dictation = useDictation({
    onText: (final, interim) => {
      if (spokenAfter.current === null) return
      setText(spokenAfter.current + final + interim)
    },
    onProblem: (message) => toast.add({ type: "error", title: message }),
  })
  const listening = dictation.state === "listening" || dictation.state === "starting"

  const startDictation = () => {
    spokenAfter.current = text && !/\s$/.test(text) ? `${text} ` : text
    void dictation.start()
    ref.current?.focus()
  }

  const ready = files.filter((f) => f.state === "ready")
  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !disabled

  const submit = () => {
    const value = text.trim()
    if (!canSend || busy) return
    if (listening) {
      spokenAfter.current = null
      dictation.stop()
    }
    onSend(
      value,
      ready.map(({ id, name, mime }) => ({ id, name, mime }))
    )
    setText("")
    setFiles([])
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        className={cn(
          "glass-strong group/composer @container relative rounded-[24px] transition-colors focus-within:border-input",
          busy && "border-rigel/30"
        )}
      >
        {busy && (
          <div className="absolute inset-x-6 -top-px h-px bg-linear-to-r from-transparent via-rigel to-transparent" />
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 px-3 pt-3" aria-label="Attached files">
            {files.map((f) => (
              <li
                key={f.key}
                className="flex h-11 max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-background/60 pr-0 pl-3 text-[12.5px] sm:h-9 sm:pr-1"
              >
                {f.state === "uploading" ? (
                  <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : f.mime.startsWith("image/") ? (
                  <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{f.name}</span>
                {f.state === "uploading" && <span className="sr-only">uploading</span>}
                <button
                  type="button"
                  onClick={() => setFiles((now) => now.filter((x) => x.key !== f.key))}
                  aria-label={`Remove ${f.name}`}
                  className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground sm:size-7"
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          value={text}
          onChange={(event) => {
            // Typing takes over from the microphone
            if (listening) {
              spokenAfter.current = null
              dictation.stop()
            }
            setText(event.target.value)
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          className="block [field-sizing:content] max-h-64 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[16px] leading-relaxed outline-none placeholder:text-faint disabled:opacity-50 sm:text-[14px]"
        />
        <div className="flex items-center gap-2 px-2.5 pt-1 pb-2.5">
          {attach && (
            <>
              <input
                ref={picker}
                type="file"
                accept={ACCEPT}
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => pick(event.target.files)}
              />
              <button
                type="button"
                onClick={() => picker.current?.click()}
                aria-label="Attach files"
                title="Attach a PDF, image, Word document or text file"
                disabled={disabled || files.length >= MAX_FILES}
                className="btn-glass size-11 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-30 sm:size-9"
              >
                <PaperclipIcon className="size-4" />
              </button>
            </>
          )}
          {leading ??
            (members && addressee && onAddresseeChange ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="btn-glass h-11 min-w-0 gap-1.5 px-3 text-[13px] sm:h-8 sm:text-[12px]">
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    to
                  </span>
                  <Glyph seed={addressee.glyph} className="size-4 rounded-[4px]" />
                  {addressee.name}
                  <ChevronDownIcon className="size-3 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {members.map((member) => (
                    <DropdownMenuItem
                      key={member.id}
                      onClick={() => onAddresseeChange(member.id)}
                    >
                      <Glyph seed={member.glyph} className="size-5" />
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate">{member.name}</span>
                        <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                          {member.role}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null)}
          <TierLabel tier={tier} className="px-1 text-[11px] text-muted-foreground" />
          {listening ? (
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px] text-destructive">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-destructive text-destructive" />
              {dictation.state === "starting" ? "starting…" : "listening"}
              <span className="hidden text-faint sm:inline">
                · {dictation.local ? "on this device" : "your browser's speech service"}
              </span>
            </span>
          ) : (
            // Always in the row so it pushes the buttons right; the hint is
            // for keyboards only
            <span className="ml-auto font-mono text-[10.5px] text-faint">
              <span className="hidden whitespace-nowrap @lg:inline">
                ↵ send · ⇧↵ newline
              </span>
            </span>
          )}
          {dictation.state !== "unsupported" && (
            <button
              type="button"
              onClick={() => (listening ? dictation.stop() : startDictation())}
              aria-label={listening ? "Stop voice typing" : "Voice typing"}
              aria-pressed={listening}
              title={listening ? "Stop voice typing" : "Speak your message"}
              disabled={disabled}
              className={cn(
                "btn-glass size-11 shrink-0 disabled:opacity-30 sm:size-9",
                listening
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {listening && (
                <span className="absolute inset-0 animate-ping rounded-full border border-destructive/40" />
              )}
              <MicIcon className="size-4" />
            </button>
          )}
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop the agent"
              className="btn-glass size-11 shrink-0 text-foreground sm:size-9"
            >
              <SquareIcon className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!canSend}
              className="btn-liquid size-11 shrink-0 sm:size-9"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
