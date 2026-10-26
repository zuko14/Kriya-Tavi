import { useId } from "react"
import {
  BriefcaseBusiness,
  CalendarDays,
  ChartNoAxesCombined,
  Clapperboard,
  CodeXml,
  Compass,
  FileSearch,
  GitPullRequestArrow,
  GraduationCap,
  Handshake,
  Headset,
  HeartPulse,
  Languages,
  LibraryBig,
  Mail,
  Megaphone,
  PenLine,
  PenTool,
  Phone,
  Plane,
  ReceiptIndianRupee,
  Rocket,
  Scale,
  Settings2,
  ShieldCheck,
  Telescope,
  UsersRound,
  type LucideIcon,
} from "lucide-react"

import { glyphSpec, toneColors, type Mark, type Tone } from "@/lib/glyph"
import { cn } from "@/lib/utils"

// One drawn line icon per mark (lib/glyph.ts says which role picks which)
export const MARK_ICONS: Record<Mark, LucideIcon> = {
  github: GitPullRequestArrow,
  engineer: CodeXml,
  finance: ReceiptIndianRupee,
  study: GraduationCap,
  watcher: Telescope,
  marketing: Megaphone,
  creator: Clapperboard,
  research: FileSearch,
  analytics: ChartNoAxesCombined,
  calendar: CalendarDays,
  career: Compass,
  hiring: UsersRound,
  support: Headset,
  sales: Handshake,
  writer: PenLine,
  mail: Mail,
  legal: Scale,
  design: PenTool,
  product: Rocket,
  health: HeartPulse,
  travel: Plane,
  language: Languages,
  calls: Phone,
  security: ShieldCheck,
  knowledge: LibraryBig,
  operations: Settings2,
  assistant: BriefcaseBusiness,
}

// Unique per instance: url(#…) resolves to the first element with an id, and a
// copy in a hidden pane (the phone-hidden sidebar) would paint nothing
const useSvgId = () => `g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`

// A deep tonal tile lit softly from above. On a 64 grid.
function Tile({ id, tones }: { id: string; tones: Tone[] }) {
  const colors = (tones.length ? tones : (["graphite"] as Tone[])).map(toneColors)
  const across = colors.length > 1
  return (
    <>
      <defs>
        {across ? (
          // A squad: its members' tones, left to right
          <linearGradient id={`${id}-t`} x1="0" y1="0" x2="1" y2="1">
            {colors.map((c, i) => (
              <stop key={i} offset={i / (colors.length - 1)} stopColor={c.top} />
            ))}
          </linearGradient>
        ) : (
          <linearGradient id={`${id}-t`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={colors[0].top} />
            <stop offset="1" stopColor={colors[0].bottom} />
          </linearGradient>
        )}
        <linearGradient id={`${id}-d`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity={across ? 0.38 : 0.12} />
        </linearGradient>
        <radialGradient id={`${id}-l`} cx="30%" cy="-10%" r="95%">
          <stop offset="0" stopColor="#fff" stopOpacity="0.26" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" fill={`url(#${id}-t)`} />
      <rect width="64" height="64" fill={`url(#${id}-d)`} />
      <rect width="64" height="64" fill={`url(#${id}-l)`} />
    </>
  )
}

// The mark, with a faint shadow under it so it sits on the tile
function Emblem({ Icon }: { Icon: LucideIcon }) {
  const props = { x: 17, y: 17, width: 30, height: 30, strokeWidth: 1.85 }
  return (
    <>
      <Icon {...props} y={18} color="#000" opacity={0.22} aria-hidden />
      <Icon {...props} color="#fff" opacity={0.96} aria-hidden />
    </>
  )
}

// The fine rim is an outline, so it follows whatever corner a caller sets
const frame =
  "size-7 shrink-0 overflow-hidden rounded-[28%] outline -outline-offset-1 outline-white/15 shadow-[0_1px_2px_rgb(10_30_32/0.25),0_6px_16px_-8px_rgb(10_30_32/0.5)]"

// An agent's face. `seed` is the agent's glyph as resolved by agentGlyph()
// (lib/glyph.ts): the person's chosen mark and tone, or its role's.
export function Glyph({
  seed,
  className,
  title,
}: {
  seed: string
  className?: string
  title?: string
}) {
  const id = useSvgId()
  const { mark, tone } = glyphSpec(seed)
  return (
    <svg
      data-slot="glyph"
      data-mark={mark}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn(frame, className)}
    >
      {title && <title>{title}</title>}
      <Tile id={id} tones={[tone]} />
      <Emblem Icon={MARK_ICONS[mark]} />
    </svg>
  )
}

// A squad: its members' tones in one tile, with the team mark
export function SquadGlyph({
  seeds,
  className,
}: {
  seeds: string[]
  className?: string
}) {
  const id = useSvgId()
  const tones = seeds.slice(0, 4).map((seed) => glyphSpec(seed).tone)
  return (
    <svg
      data-slot="squad-glyph"
      viewBox="0 0 64 64"
      aria-hidden
      className={cn(frame, className)}
    >
      <Tile id={id} tones={tones} />
      <Emblem Icon={UsersRound} />
    </svg>
  )
}
