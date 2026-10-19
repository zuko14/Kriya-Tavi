// Deterministic agent marks: a seed always draws the same small glass tile,
// a two-tone aurora behind one emblem. Pure functions, so they render on the
// server.

function fnv1a(input: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// Hue pairs (base, glow) drawn from the brand: teal, terracotta, saffron and
// their neighbours, chosen to read well on the cream and the night theme
const PALETTES: [number, number][] = [
  [195, 60], // teal → saffron
  [185, 150], // deep teal → mint
  [40, 75], // terracotta → gold
  [265, 330], // indigo → rose
  [300, 30], // plum → coral
  [225, 190], // ocean → aqua
  [160, 95], // emerald → lime-gold
  [20, 340], // ember → berry
  [245, 205], // midnight → sky
  [55, 15], // amber → copper
]

export const EMBLEMS = [
  "spark",
  "orbit",
  "wave",
  "bloom",
  "prism",
  "crescent",
  "loop",
  "leaf",
  "gem",
  "rings",
  "sun",
  "hex",
] as const
export type Emblem = (typeof EMBLEMS)[number]

export type GlyphSpec = { base: number; glow: number; emblem: Emblem }

export function glyphSpec(seed: string): GlyphSpec {
  const hash = fnv1a(seed || "kriya")
  const [base, glow] = PALETTES[hash % PALETTES.length]
  // A different slice of the hash, so palette and emblem vary independently
  const emblem = EMBLEMS[Math.floor(hash / PALETTES.length) % EMBLEMS.length]
  return { base, glow, emblem }
}
