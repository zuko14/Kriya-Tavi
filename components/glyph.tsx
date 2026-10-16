import { glyphSpec } from "@/lib/glyph"
import { cn } from "@/lib/utils"

function Sky({
  seed,
  x = 0,
  y = 0,
  size = 32,
}: {
  seed: string
  x?: number
  y?: number
  size?: number
}) {
  const { hue, stars, edges } = glyphSpec(seed)
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      preserveAspectRatio="xMidYMid slice"
    >
      <rect width="32" height="32" fill={`oklch(0.25 0.06 ${hue})`} />
      <rect width="32" height="18" fill={`oklch(0.32 0.07 ${hue} / 0.55)`} />
      <g
        stroke={`oklch(0.88 0.08 ${hue} / 0.5)`}
        strokeWidth="0.85"
        strokeLinecap="round"
      >
        {edges.map(([a, b], i) => (
          <line key={i} x1={stars[a].x} y1={stars[a].y} x2={stars[b].x} y2={stars[b].y} />
        ))}
      </g>
      {stars.map((star, i) =>
        star.r >= 2 ? (
          <g key={i}>
            <circle
              cx={star.x}
              cy={star.y}
              r={4.2}
              fill={`oklch(0.9 0.1 ${hue} / 0.22)`}
            />
            <circle cx={star.x} cy={star.y} r={star.r} fill={`oklch(0.98 0.03 ${hue})`} />
          </g>
        ) : (
          <circle
            key={i}
            cx={star.x}
            cy={star.y}
            r={star.r}
            fill={`oklch(0.93 0.05 ${hue})`}
          />
        )
      )}
    </svg>
  )
}

// An agent's face: a small generated constellation
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
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn(
        "size-7 shrink-0 overflow-hidden rounded-[22%] ring-1 ring-black/10 ring-inset dark:ring-white/10",
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
      ? [{ x: 0, y: 0, w: 32, h: 32 }]
      : visible.length === 2
        ? [
            { x: 0, y: 0, w: 15.5, h: 32 },
            { x: 16.5, y: 0, w: 15.5, h: 32 },
          ]
        : visible.length === 3
          ? [
              { x: 0, y: 0, w: 15.5, h: 32 },
              { x: 16.5, y: 0, w: 15.5, h: 15.5 },
              { x: 16.5, y: 16.5, w: 15.5, h: 15.5 },
            ]
          : [
              { x: 0, y: 0, w: 15.5, h: 15.5 },
              { x: 16.5, y: 0, w: 15.5, h: 15.5 },
              { x: 0, y: 16.5, w: 15.5, h: 15.5 },
              { x: 16.5, y: 16.5, w: 15.5, h: 15.5 },
            ]

  return (
    <svg
      data-slot="squad-glyph"
      viewBox="0 0 32 32"
      aria-hidden
      className={cn("size-7 shrink-0 overflow-hidden rounded-[22%] bg-border", className)}
    >
      {visible.map((seed, i) => (
        <svg
          key={i}
          x={tiles[i].x}
          y={tiles[i].y}
          width={tiles[i].w}
          height={tiles[i].h}
          viewBox="0 0 32 32"
          preserveAspectRatio="xMidYMid slice"
        >
          <Sky seed={seed} />
        </svg>
      ))}
    </svg>
  )
}
