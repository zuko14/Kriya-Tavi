import Image from "next/image"

import { cn } from "@/lib/utils"

// The Kriya mark, as stitched on Tavi: a split stem, a rising arm, a blade
// leg, and the terracotta leaf where they meet.
const K_PATHS = [
  "M17 13h8.5v17.5L17 39z",
  "M17 44l8.5-8.5V51H17z",
  "M29 31 43 13h9.5L33.5 35z",
  "M30 39.5c9.5 0.5 17 4.5 22 11.5H41.5c-4.5-3.5-8.5-7.2-11.5-11.5z",
]
const LEAF = "M33.5 36.5c4.6-3.6 10-4.8 15.5-3.8-4.4 4-9.8 5.3-15.5 3.8z"

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("size-6 shrink-0", className)}>
      <defs>
        <linearGradient id="tavi-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2A6466" />
          <stop offset="1" stopColor="#10292B" />
        </linearGradient>
        <linearGradient id="tavi-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.28" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#tavi-tile)" />
      <rect width="64" height="64" rx="18" fill="url(#tavi-sheen)" />
      <rect
        x="0.5"
        y="0.5"
        width="63"
        height="63"
        rx="17.5"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.16"
      />
      <g transform="translate(6.4 6.4) scale(0.8)" fill="#FCE6C6">
        {K_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
        <path d={LEAF} fill="#E09A62" />
      </g>
    </svg>
  )
}

// The bare K, in the current text colour
export function KGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("size-6 shrink-0", className)}>
      {K_PATHS.map((d) => (
        <path key={d} d={d} fill="currentColor" />
      ))}
      <path d={LEAF} fill="#CD8851" />
    </svg>
  )
}

export function Wordmark({ className, full }: { className?: string; full?: boolean }) {
  return (
    <span className={cn("text-[15px] font-semibold tracking-[-0.02em]", className)}>
      Kriya
      <span className="ml-[0.22em] font-display font-normal text-rigel italic">Tavi</span>
      {full && (
        <span className="ml-2 align-middle font-mono text-[10px] font-normal tracking-wide text-faint uppercase">
          by Kriya AI
        </span>
      )}
    </span>
  )
}

// Tavi, the mascot. The studio shot sits on cream, so its edges are
// feathered; place it on a cream (studio) surface.
export function Mascot({
  className,
  priority,
  sizes = "320px",
}: {
  className?: string
  priority?: boolean
  sizes?: string
}) {
  return (
    <Image
      src="/tavi/mascot.webp"
      alt="Tavi, the Kriya mascot"
      width={1024}
      height={1024}
      // Next 16: eager + high fetch priority replaces the deprecated `priority`
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      sizes={sizes}
      draggable={false}
      className={cn(
        "pointer-events-none [mask-image:radial-gradient(closest-side,black_70%,transparent)] select-none",
        className
      )}
    />
  )
}
