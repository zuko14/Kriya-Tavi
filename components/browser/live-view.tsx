"use client"

import * as React from "react"
import { KeyboardIcon, KeyRoundIcon, LockIcon, LockOpenIcon } from "lucide-react"

import type { LiveInput, LiveKey, LiveOutput } from "@/browser/protocol"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Take-over (BROWSER_AND_LOGIN_PROFILES.md §5, UX_SPEC §6): the person sees
// Kriya's browser and types into it themselves. Frames are shown and never
// kept; what they type goes to the site through kriya-browser and isn't
// stored or recorded there either.

const KEYS: Record<string, LiveKey> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Escape: "Escape",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
}

// Generated here, on the device (AD-04): Kriya never sees it unless the
// person types it into the page
function strongPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?"
  const bytes = crypto.getRandomValues(new Uint32Array(20))
  return Array.from(bytes, (b) => chars[b % chars.length]).join("")
}

export function LiveView({
  sessionId,
  domain,
  reason,
  onDone,
  onCancel,
}: {
  sessionId: string
  domain: string
  reason: string
  onDone: () => void
  onCancel: () => void
}) {
  const [status, setStatus] = React.useState<"connecting" | "live" | "ended">(
    "connecting"
  )
  const [error, setError] = React.useState<string | null>(null)
  const [url, setUrl] = React.useState("")
  const [size, setSize] = React.useState({ width: 390, height: 844 })
  const [password, setPassword] = React.useState<string | null>(null)
  const socket = React.useRef<WebSocket | null>(null)
  const screen = React.useRef<HTMLImageElement>(null)
  const keyboard = React.useRef<HTMLTextAreaElement>(null)
  const pressed = React.useRef(false)

  const send = React.useCallback((input: LiveInput) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(input))
  }, [])

  React.useEffect(() => {
    let closed = false
    let ping: ReturnType<typeof setInterval> | undefined
    ;(async () => {
      const response = await fetch(`/api/browser/live/${sessionId}/token`, {
        method: "POST",
      })
      const body = (await response.json().catch(() => null)) as {
        url?: string
        error?: string
      } | null
      if (closed) return
      if (!response.ok || !body?.url) {
        setError(body?.error ?? "The live view couldn't start.")
        setStatus("ended")
        return
      }
      const ws = new WebSocket(body.url)
      socket.current = ws
      ws.onopen = () => setStatus("live")
      ws.onmessage = (event) => {
        let message: LiveOutput
        try {
          message = JSON.parse(String(event.data)) as LiveOutput
        } catch {
          return
        }
        if (message.t === "frame" && screen.current) {
          screen.current.src = `data:image/jpeg;base64,${message.data}`
          setSize((current) =>
            current.width === message.width && current.height === message.height
              ? current
              : { width: message.width, height: message.height }
          )
        } else if (message.t === "page") setUrl(message.url)
        else if (message.t === "ended" && message.reason !== "done") {
          setError(message.reason)
        }
      }
      ws.onclose = () => {
        if (!closed) setStatus("ended")
      }
      // The session stays open while someone is looking at it
      ping = setInterval(() => send({ t: "ping" }), 10_000)
    })().catch(() => {
      if (!closed) {
        setError("The live view couldn't start.")
        setStatus("ended")
      }
    })
    return () => {
      closed = true
      clearInterval(ping)
      socket.current?.close()
      socket.current = null
    }
  }, [sessionId, send])

  // Where on the page, in the browser's own pixels
  const point = (event: React.PointerEvent | React.WheelEvent) => {
    const rect = screen.current!.getBoundingClientRect()
    return {
      x: Math.round(((event.clientX - rect.left) * size.width) / rect.width),
      y: Math.round(((event.clientY - rect.top) * size.height) / rect.height),
    }
  }

  let host = domain
  let secure = false
  try {
    const parsed = new URL(url)
    host = parsed.host
    secure = parsed.protocol === "https:"
  } catch {}

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Sign in to ${domain}`}
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <header className="flex min-h-14 items-center gap-2 border-b px-4">
        {secure ? (
          <LockIcon className="size-4 shrink-0 text-ok" aria-label="secure" />
        ) : (
          <LockOpenIcon className="size-4 shrink-0 text-faint" aria-label="not secure" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{host}</span>
        <span className="label-mono shrink-0">You&apos;re in control</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          onClick={onCancel}
        >
          Stop
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-auto bg-muted/30">
        {status === "connecting" && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner className="size-5 text-rigel" />
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element -- live frames, never stored */}
        <img
          ref={screen}
          alt={`Live view of ${host}`}
          draggable={false}
          className="mx-auto block w-full max-w-[640px] touch-none select-none"
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
          onPointerDown={(event) => {
            pressed.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            send({ t: "down", ...point(event) })
          }}
          onPointerMove={(event) => {
            if (pressed.current) send({ t: "move", ...point(event) })
          }}
          onPointerUp={(event) => {
            pressed.current = false
            send({ t: "up", ...point(event) })
            // A tap on a field should bring up the keyboard
            keyboard.current?.focus({ preventScroll: true })
          }}
          onWheel={(event) => send({ t: "wheel", ...point(event), dy: event.deltaY })}
        />
        <textarea
          ref={keyboard}
          aria-label="Type into the page"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="absolute bottom-0 left-0 size-px opacity-0"
          onKeyDown={(event) => {
            const key = KEYS[event.key]
            if (key) {
              event.preventDefault()
              send({ t: "key", key })
            }
          }}
          onInput={(event) => {
            const text = event.currentTarget.value
            event.currentTarget.value = ""
            if (text) send({ t: "text", text })
          }}
        />
      </div>

      <footer className="flex flex-col gap-3 border-t px-4 py-3">
        <p className="text-[13px]">{reason}</p>
        {error && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}
        <p className="text-[11.5px] text-muted-foreground">
          What you type here goes to the site through Kriya&apos;s browser. Kriya
          doesn&apos;t store or record it.
        </p>
        {password && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
            <code className="min-w-0 flex-1 font-code text-[12.5px] break-all">
              {password}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => void navigator.clipboard?.writeText(password)}
            >
              Copy
            </Button>
            <p className="w-full text-[11.5px] text-muted-foreground">
              Made on this device. Save it in your password manager before you use it.
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-11 flex-1"
            disabled={status !== "live"}
            onClick={onDone}
          >
            Done
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={status !== "live"}
            onClick={() => keyboard.current?.focus({ preventScroll: true })}
          >
            <KeyboardIcon className="size-4" /> Keyboard
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setPassword(strongPassword())}
          >
            <KeyRoundIcon className="size-4" /> Suggest a password
          </Button>
          <Button type="button" variant="ghost" className="min-h-11" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </footer>
    </div>
  )
}
