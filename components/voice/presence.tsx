import { CheckIcon } from "lucide-react"

import { Mascot } from "@/components/brand"
import { cn } from "@/lib/utils"

// What Tavi is doing, on every voice screen (UX_AND_INTERACTION_SPEC §11.1):
// the mascot in a disc, with CSS-only motion from existing keyframes, and
// always words beside it, so reduced motion (globals.css) and screen readers
// lose nothing. Only transform and opacity move (§11.7). The disc has a fixed
// size, so a state change never shifts the layout.

export type PresenceState =
  | "idle"
  | "listening"
  | "thinking"
  | "dialing"
  | "talking"
  | "hearing"
  | "done"
  | "attention"

const ring = "absolute inset-0 rounded-full border-2"

export function Presence({
  state,
  words,
  level = 0,
  onPress,
  pressLabel,
  className,
}: {
  state: PresenceState
  words?: string | null
  // 0–1, how much is being heard (listening)
  level?: number
  // The disc as a button (tap to dictate, §11.2)
  onPress?: () => void
  pressLabel?: string
  className?: string
}) {
  const disc = (
    <span className="relative grid size-24 shrink-0 place-items-center">
      {state === "dialing" && (
        <>
          <span
            className={cn(ring, "animate-ping border-rigel/60 [animation-duration:1.2s]")}
          />
          <span
            className={cn(
              ring,
              "animate-ping border-rigel/40 [animation-delay:600ms] [animation-duration:1.2s]"
            )}
          />
        </>
      )}
      {state === "listening" && (
        <span
          className={cn(ring, "border-rigel transition-transform duration-150 ease-out")}
          style={{ transform: `scale(${1 + Math.min(Math.max(level, 0), 1) * 0.18})` }}
        />
      )}
      {state === "talking" && <span className={cn(ring, "animate-pulse border-rigel")} />}
      {state === "hearing" && (
        <span className={cn(ring, "animate-pulse border-betelgeuse")} />
      )}
      {state === "attention" && (
        <span className={cn(ring, "border-[3px] border-betelgeuse")} />
      )}
      {state === "thinking" && (
        <span className="absolute inset-0 animate-spin [animation-duration:3s]">
          <span className="absolute top-0 left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-rigel" />
        </span>
      )}
      <span className="grid size-[84px] place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle,#fbf5ee,#efe3d6)] shadow-[0_12px_30px_-14px_rgb(0_0_0/0.45)] ring-1 ring-black/5">
        <Mascot
          sizes="96px"
          className={cn(
            "w-[118%] max-w-none",
            state === "idle" && "animate-[tavi-breathe_4s_ease-in-out_infinite]"
          )}
        />
      </span>
      {state === "done" && (
        <span className="rise absolute right-0 bottom-0 grid size-7 place-items-center rounded-full bg-rigel text-background">
          <CheckIcon className="size-4" />
        </span>
      )}
    </span>
  )
  return (
    <div className={cn("flex items-center gap-4", className)}>
      {onPress ? (
        <button
          type="button"
          onClick={onPress}
          aria-label={pressLabel}
          aria-pressed={state === "listening"}
          className="press rounded-full focus-visible:ring-2 focus-visible:ring-rigel focus-visible:outline-none"
        >
          {disc}
        </button>
      ) : (
        disc
      )}
      <p
        role="status"
        aria-live="polite"
        className="min-w-0 flex-1 text-[14.5px] leading-snug text-balance"
      >
        {words}
      </p>
    </div>
  )
}
