"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"

import { KGlyph, Mascot } from "@/components/brand"

const SEEN_KEY = "tavi-intro-seen"

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, "1")
  } catch {}
}

// The opening shot: Tavi waddles across a cream studio floor in front of
// "Kriya AI", then the welcome. Plays once per browser session; the inline
// script hides it before first paint for anyone who has already seen it.
export function Intro({ enterHref }: { enterHref: string }) {
  const [state, setState] = React.useState<"playing" | "leaving" | "gone">("playing")
  const enterRef = React.useRef<HTMLAnchorElement>(null)

  const close = React.useCallback(() => {
    markSeen()
    setState("leaving")
    window.setTimeout(() => setState("gone"), 550)
  }, [])

  React.useEffect(() => {
    let seen = false
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === "1"
    } catch {}
    const root = document.documentElement
    if (seen) {
      // Covers client-side navigation here, where the inline script never runs
      root.dataset.introSeen = "1"
      return
    }
    root.style.overflow = "hidden"
    const focus = window.setTimeout(() => enterRef.current?.focus(), 2900)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      root.style.overflow = ""
      window.clearTimeout(focus)
      window.removeEventListener("keydown", onKey)
    }
  }, [close])

  React.useEffect(() => {
    if (state === "gone") document.documentElement.style.overflow = ""
  }, [state])

  if (state === "gone") return null

  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `try{if(sessionStorage.getItem("${SEEN_KEY}")==="1")document.documentElement.dataset.introSeen="1"}catch(e){}`,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Kriya Tavi"
        data-state={state}
        className="tavi-intro fixed inset-0 z-[100] flex flex-col overflow-hidden text-[#13292b]"
      >
        <div className="tavi-intro-studio absolute inset-0" />

        <div className="relative z-10 flex items-center justify-between px-5 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
          <span className="tavi-fade-1 flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]">
            <KGlyph className="size-5 text-[#1d3f42]" />
            Kriya AI
          </span>
          <button
            type="button"
            onClick={close}
            className="tavi-fade-1 min-h-11 rounded-full px-4 text-[12.5px] font-medium text-[#13292b]/60 transition-colors hover:text-[#13292b]"
          >
            Skip
          </button>
        </div>

        <div className="relative flex flex-1 flex-col items-center justify-center px-5 pb-[env(safe-area-inset-bottom)]">
          {/* The backdrop word Tavi walks in front of */}
          <span
            aria-hidden
            className="tavi-backword pointer-events-none absolute top-[18%] text-center font-display text-[24vw] leading-none font-semibold whitespace-nowrap text-[#1d3f42] sm:top-[10%] sm:text-[15vw]"
          >
            Kriya AI
          </span>

          <div className="tavi-walk relative w-[min(56vw,300px)] sm:w-[min(30vw,330px)]">
            <div className="tavi-waddle">
              <Mascot
                priority
                sizes="(min-width: 640px) 330px, 56vw"
                className="w-full"
              />
            </div>
            <span
              aria-hidden
              className="tavi-shadow absolute bottom-[6%] left-1/2 -z-10 h-6 w-[58%] -translate-x-1/2 rounded-[50%] bg-[#1d3f42]/30 blur-md"
            />
          </div>

          <div className="relative mt-4 flex flex-col items-center gap-2 text-center sm:mt-6">
            <p className="tavi-fade-2 font-mono text-[10.5px] tracking-[0.32em] text-[#1d3f42]/60 uppercase">
              Kriya AI presents
            </p>
            <h1 className="tavi-fade-3 font-display text-[34px] leading-[1.05] font-normal text-balance sm:text-[56px]">
              Welcome to Kriya <em className="text-[#b4622f]">Tavi</em>
            </h1>
            <p className="tavi-fade-3 max-w-sm text-[14px] leading-relaxed text-balance text-[#13292b]/65 sm:text-[15px]">
              Your personal AI, with a team of agents behind it.
            </p>
            <div className="tavi-fade-4 mt-5 flex flex-col items-center gap-1 sm:flex-row sm:gap-3">
              <Link
                ref={enterRef}
                href={enterHref}
                onClick={markSeen}
                className="btn-liquid btn-ink h-12 px-7 text-[15px]"
              >
                Enter Kriya Tavi
                <ArrowRightIcon className="size-4" />
              </Link>
              <button
                type="button"
                onClick={close}
                className="min-h-11 rounded-full px-5 text-[14px] font-medium text-[#13292b]/70 transition-colors hover:text-[#13292b]"
              >
                Look around first
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
