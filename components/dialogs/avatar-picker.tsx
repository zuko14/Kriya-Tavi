"use client"

import { CheckIcon } from "lucide-react"

import { Glyph } from "@/components/glyph"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  agentGlyph,
  glyphSpec,
  glyphValue,
  MARKS,
  parseGlyph,
  TONE_IDS,
  toneColors,
} from "@/lib/glyph"
import { cn } from "@/lib/utils"

// The agent's avatar in the Creator: automatic (its role picks the mark) or a
// mark and tone the person chooses. `value` is "auto" or "<mark>:<tone>".
export function AvatarPicker({
  value,
  role,
  name,
  onChange,
}: {
  value: string | undefined
  role: string
  name: string
  onChange: (value: string) => void
}) {
  const chosen = parseGlyph(value)
  const shown = agentGlyph({ glyph: chosen ? value : null, role })
  const { mark, tone } = glyphSpec(shown)
  const label = MARKS.find((m) => m.id === mark)!.label

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Avatar: ${label}. Change it`}
        className="group flex min-h-11 flex-col items-center gap-1.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Glyph
          seed={shown}
          title={name ? `${name}'s avatar` : "Avatar"}
          className="size-[60px] transition-transform group-hover:scale-[1.03]"
        />
        <span className="font-mono text-[10.5px] text-muted-foreground group-hover:text-foreground">
          {chosen ? "change" : "auto · change"}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[19rem] gap-3">
        <button
          type="button"
          onClick={() => onChange("auto")}
          aria-pressed={!chosen}
          className={cn(
            "flex min-h-11 items-center gap-2.5 rounded-md border px-2.5 text-left text-[13px] transition-colors hover:bg-accent/50",
            !chosen && "border-rigel bg-rigel-soft"
          )}
        >
          <Glyph seed={agentGlyph({ glyph: null, role })} className="size-7" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">Match the role</span>
            <span className="truncate text-[11.5px] text-muted-foreground">
              Changes when the role does
            </span>
          </span>
          {!chosen && <CheckIcon className="size-4 text-rigel" aria-hidden />}
        </button>

        <div>
          <p className="label-mono mb-1.5">Mark</p>
          <div role="radiogroup" aria-label="Mark" className="grid grid-cols-6 gap-1">
            {MARKS.map((m) => {
              const on = chosen?.mark === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={m.label}
                  title={m.label}
                  onClick={() => onChange(glyphValue({ mark: m.id, tone }))}
                  className={cn(
                    "grid size-11 place-items-center rounded-md transition-colors hover:bg-accent/60",
                    on && "bg-rigel-soft ring-2 ring-rigel"
                  )}
                >
                  <Glyph seed={glyphValue({ mark: m.id, tone })} className="size-8" />
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <p className="label-mono mb-1.5">Tone</p>
          <div role="radiogroup" aria-label="Tone" className="grid grid-cols-6 gap-1">
            {TONE_IDS.map((t) => {
              const on = chosen?.tone === t
              const { top, bottom } = toneColors(t)
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={t}
                  title={t[0].toUpperCase() + t.slice(1)}
                  onClick={() => onChange(glyphValue({ mark, tone: t }))}
                  className="grid size-11 place-items-center rounded-md hover:bg-accent/60"
                >
                  <span
                    className={cn(
                      "size-7 rounded-full outline -outline-offset-1 outline-white/20",
                      on && "ring-2 ring-rigel ring-offset-2 ring-offset-popover"
                    )}
                    style={{ background: `linear-gradient(180deg, ${top}, ${bottom})` }}
                  />
                </button>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
