"use client"

import * as React from "react"
import { ArrowUpIcon, ChevronDownIcon, MicIcon, SquareIcon } from "lucide-react"

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
}: {
  placeholder: string
  busy: boolean
  disabled?: boolean
  onSend: (text: string) => void
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
}) {
  const [text, setText] = React.useState("")
  const ref = React.useRef<HTMLTextAreaElement>(null)

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

  const submit = () => {
    const value = text.trim()
    if (!value || busy || disabled) return
    if (listening) {
      spokenAfter.current = null
      dictation.stop()
    }
    onSend(value)
    setText("")
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
          {leading ??
            (members && addressee && onAddresseeChange ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="flex h-11 min-w-0 items-center gap-1.5 rounded-full border bg-background/50 px-3 text-[13px] hover:bg-accent sm:h-8 sm:text-[12px]">
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
                "relative grid size-11 shrink-0 place-items-center rounded-xl border transition-colors disabled:opacity-30 sm:size-9",
                listening
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {listening && (
                <span className="absolute inset-0 animate-ping rounded-lg border border-destructive/40" />
              )}
              <MicIcon className="size-4" />
            </button>
          )}
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop the agent"
              className="grid size-11 shrink-0 place-items-center rounded-xl border bg-background text-foreground transition-colors hover:bg-accent sm:size-9"
            >
              <SquareIcon className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!text.trim() || disabled}
              className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground transition-opacity disabled:opacity-30 sm:size-9"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
