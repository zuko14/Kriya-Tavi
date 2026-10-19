import { useId } from "react"

import { glyphSpec, type Emblem } from "@/lib/glyph"
import { cn } from "@/lib/utils"

// Emblems on a 64-unit grid, centred on 32,32. Stroked ones share one pen;
// filled ones are solid. Drawn twice: a soft wide halo, then the crisp line.
const STROKED: Partial<Record<Emblem, React.ReactNode>> = {
  orbit: (
    <>
      <ellipse cx="32" cy="32" rx="14" ry="6.5" transform="rotate(-28 32 32)" />
      <circle cx="43.5" cy="24.5" r="1.6" />
    </>
  ),
  wave: (
    <>
      <path d="M18 28c4.5-5 9-5 14 0s9.5 5 14 0" />
      <path d="M18 37c4.5-5 9-5 14 0s9.5 5 14 0" />
    </>
  ),
  prism: (
    <>
      <path d="M32 18 46 43H18Z" />
      <path d="M32 18v25" />
    </>
  ),
  loop: <path d="M32 32c-4-6-12-6-12 0s8 6 12 0 12-6 12 0-8 6-12 0Z" />,
  leaf: (
    <>
      <path d="M19 45c0-16 10-25 26-26 0 15-9 26-26 26Z" />
      <path d="m19 45 15-15" />
    </>
  ),
  gem: <path d="m32 16 16 16-16 16-16-16Z" />,
  rings: <circle cx="32" cy="32" r="12.5" />,
  sun: (
    <path d="M32 15v4M32 45v4M15 32h4M45 32h4M20 20l2.8 2.8M41.2 41.2 44 44M20 44l2.8-2.8M41.2 22.8 44 20" />
  ),
  hex: <path d="m32 18.5 11.7 6.75v13.5L32 45.5l-11.7-6.75v-13.5Z" />,
}
const FILLED: Partial<Record<Emblem, React.ReactNode>> = {
  spark: (
    <path d="M32 16c1.4 9.6 5.4 13.9 15 16-9.6 2.1-13.6 6.4-15 16-1.4-9.6-5.4-13.9-15-16 9.6-2.1 13.6-6.4 15-16Z" />
  ),
  orbit: <circle cx="32" cy="32" r="4.6" />,
  bloom: (
    <>
      <path d="M32 32c-5.5-5-5.5-12 0-16 5.5 4 5.5 11 0 16Z" />
      <path
        d="M32 32c-5.5-5-5.5-12 0-16 5.5 4 5.5 11 0 16Z"
        transform="rotate(120 32 32)"
      />
      <path
        d="M32 32c-5.5-5-5.5-12 0-16 5.5 4 5.5 11 0 16Z"
        transform="rotate(240 32 32)"
      />
    </>
  ),
  crescent: (
    <>
      <path d="M37 18a14 14 0 1 0 0 28 11 11 0 1 1 0-28Z" />
      <circle cx="44" cy="22" r="2" />
    </>
  ),
  gem: <path d="m32 25 7 7-7 7-7-7Z" />,
  rings: <circle cx="32" cy="32" r="5" />,
  sun: <circle cx="32" cy="32" r="7" />,
  hex: <circle cx="32" cy="32" r="3.2" />,
}

function Sky({
  seed,
  x = 0,
  y = 0,
  size = 64,
}: {
  seed: string
  x?: number
  y?: number
  size?: number
}) {
  const { base, glow, emblem } = glyphSpec(seed)
  // Unique per instance: url(#…) resolves to the first element with an id,
  // and a copy in a hidden pane (the phone-hidden sidebar) paints nothing
  const id = `g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const ink = `oklch(0.985 0.02 ${glow})`
  const stroked = STROKED[emblem]
  const filled = FILLED[emblem]
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id={`${id}-a`} cx="22%" cy="18%" r="85%">
          <stop offset="0" stopColor={`oklch(0.62 0.15 ${base})`} />
          <stop offset="1" stopColor={`oklch(0.27 0.08 ${base})`} />
        </radialGradient>
        <radialGradient id={`${id}-b`} cx="88%" cy="92%" r="70%">
          <stop offset="0" stopColor={`oklch(0.78 0.15 ${glow})`} stopOpacity="0.9" />
          <stop offset="1" stopColor={`oklch(0.78 0.15 ${glow})`} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-c`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={ink} stopOpacity="0.32" />
          <stop offset="1" stopColor={ink} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.42" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.06" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" fill={`url(#${id}-a)`} />
      <rect width="64" height="64" fill={`url(#${id}-b)`} />
      <circle cx="32" cy="32" r="22" fill={`url(#${id}-c)`} />
      {stroked && (
        <g fill="none" stroke={ink} strokeLinecap="round" strokeLinejoin="round">
          <g strokeWidth="7" strokeOpacity="0.16">
            {stroked}
          </g>
          <g strokeWidth="3">{stroked}</g>
        </g>
      )}
      {filled && <g fill={ink}>{filled}</g>}
      {/* Glass: a sheen on the upper half */}
      <path d="M0 0h64v30C46 38 18 38 0 30Z" fill={`url(#${id}-s)`} />
    </svg>
  )
}

// An agent's face: a small generated glass tile
export function Glyph({
  seed,
  className,
  title,
}: {
  seed: string
  className?: string
  title?: string
}) {
  return (
    <svg
      data-slot="glyph"
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn(
        "size-7 shrink-0 overflow-hidden rounded-[26%] shadow-[0_6px_14px_-6px_rgb(10_30_32/0.55)] ring-1 ring-black/10 ring-inset dark:ring-white/10",
        className
      )}
    >
      {title && <title>{title}</title>}
      <Sky seed={seed} />
    </svg>
  )
}

// A squad: its members' skies tiled into one square
export function SquadGlyph({
  seeds,
  className,
}: {
  seeds: string[]
  className?: string
}) {
  const visible = seeds.slice(0, 4)
  const tiles =
    visible.length <= 1
      ? [{ x: 0, y: 0, w: 64, h: 64 }]
      : visible.length === 2
        ? [
            { x: 0, y: 0, w: 31, h: 64 },
            { x: 33, y: 0, w: 31, h: 64 },
          ]
        : visible.length === 3
          ? [
              { x: 0, y: 0, w: 31, h: 64 },
              { x: 33, y: 0, w: 31, h: 31 },
              { x: 33, y: 33, w: 31, h: 31 },
            ]
          : [
              { x: 0, y: 0, w: 31, h: 31 },
              { x: 33, y: 0, w: 31, h: 31 },
              { x: 0, y: 33, w: 31, h: 31 },
              { x: 33, y: 33, w: 31, h: 31 },
            ]

  return (
    <svg
      data-slot="squad-glyph"
      viewBox="0 0 64 64"
      aria-hidden
      className={cn(
        "size-7 shrink-0 overflow-hidden rounded-[26%] bg-border shadow-[0_6px_14px_-6px_rgb(10_30_32/0.55)]",
        className
      )}
    >
      {visible.map((seed, i) => (
        <svg
          key={i}
          x={tiles[i].x}
          y={tiles[i].y}
          width={tiles[i].w}
          height={tiles[i].h}
          viewBox="0 0 64 64"
          preserveAspectRatio="xMidYMid slice"
        >
          <Sky seed={seed} />
        </svg>
      ))}
    </svg>
  )
}
