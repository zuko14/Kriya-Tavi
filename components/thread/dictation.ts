"use client"

import * as React from "react"

// Voice typing through the browser's own speech recognition. Where the
// browser can recognise speech on the device (recent Chrome), it does, so
// audio never leaves the computer; otherwise the browser's speech service
// is used (Google's in Chrome, Microsoft's in Edge) and the composer says so.

type Result = { isFinal: boolean; 0: { transcript: string } }
type ResultEvent = { resultIndex: number; results: ArrayLike<Result> }

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  processLocally?: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: ResultEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

type RecognitionClass = {
  new (): Recognition
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>
}

function recognitionClass(): RecognitionClass | null {
  if (typeof window === "undefined") return null
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionClass
    webkitSpeechRecognition?: RecognitionClass
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

// Whether the browser can recognise this language on the device right now.
// Asked once per page, ahead of the first click, so starting never waits.
const deviceSupport = new Map<string, Promise<"ready" | "downloadable" | "no">>()

function checkOnDevice(Class: RecognitionClass, lang: string) {
  let check = deviceSupport.get(lang)
  if (!check) {
    check = (async () => {
      if (!Class.available || !("processLocally" in Class.prototype)) return "no" as const
      try {
        const status = await Class.available({ langs: [lang], processLocally: true })
        return status === "available"
          ? ("ready" as const)
          : status === "downloadable"
            ? ("downloadable" as const)
            : ("no" as const)
      } catch {
        return "no" as const
      }
    })()
    deviceSupport.set(lang, check)
  }
  return check
}

// Recognition on the device if it's ready this instant. If it could be
// downloaded, that starts in the background (it needs the click that
// started voice typing) and is used from the next time on.
async function onDevice(Class: RecognitionClass, lang: string) {
  const status = await Promise.race([
    checkOnDevice(Class, lang),
    new Promise<"no">((resolve) => setTimeout(() => resolve("no"), 120)),
  ])
  if (status === "downloadable" && Class.install) {
    deviceSupport.delete(lang)
    void Class.install({ langs: [lang], processLocally: true }).catch(() => {})
  }
  return status === "ready"
}

const PROBLEMS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked for Kriya in this browser.",
  "service-not-allowed": "This browser doesn't allow voice typing here.",
  "audio-capture": "No microphone was found.",
  network: "Your browser's speech service couldn't be reached.",
  "language-not-supported": "Voice typing doesn't support this language yet.",
}

export type DictationState = "unsupported" | "idle" | "starting" | "listening"

export function useDictation({
  onText,
  onProblem,
}: {
  // Everything recognised in this session so far, and the words still
  // being heard
  onText: (final: string, interim: string) => void
  onProblem: (message: string) => void
}) {
  const [state, setState] = React.useState<DictationState>("idle")
  const [local, setLocal] = React.useState(false)
  const recognition = React.useRef<Recognition | null>(null)
  const handlers = React.useRef({ onText, onProblem })
  React.useEffect(() => {
    handlers.current = { onText, onProblem }
  }, [onText, onProblem])

  React.useEffect(() => {
    const Class = recognitionClass()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!Class) setState("unsupported")
    // Ask about on-device recognition now, not when the mic is clicked
    else void checkOnDevice(Class, navigator.language || "en-US")
    return () => recognition.current?.abort()
  }, [])

  const stop = React.useCallback(() => {
    recognition.current?.stop()
  }, [])

  const start = React.useCallback(async () => {
    const Class = recognitionClass()
    if (!Class || recognition.current) return
    setState("starting")
    const lang = navigator.language || "en-US"
    const instance = new Class()
    instance.lang = lang
    instance.continuous = true
    instance.interimResults = true
    const device = await onDevice(Class, lang)
    if (device) instance.processLocally = true
    setLocal(device)

    let final = ""
    instance.onstart = () => setState("listening")
    instance.onresult = (event) => {
      let interim = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) final += result[0].transcript
        else interim += result[0].transcript
      }
      handlers.current.onText(final, interim)
    }
    instance.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return
      handlers.current.onProblem(
        PROBLEMS[event.error] ?? `Voice typing stopped: ${event.error}`
      )
    }
    instance.onend = () => {
      recognition.current = null
      setState("idle")
      handlers.current.onText(final, "")
    }
    recognition.current = instance
    try {
      instance.start()
    } catch {
      recognition.current = null
      setState("idle")
    }
  }, [])

  return { state, local, start, stop }
}
