// Agent avatars: a professional mark on a deep tonal tile. Pure functions,
// safe on the server and in the browser.
//
// What's stored in kriya.agents.glyph:
// - "<mark>:<tone>": the person chose this avatar in the agent dialog;
// - anything else (a random seed, as every agent made before had): automatic,
//   the mark follows the agent's role, so it changes when the role does.
// Every place that hands a glyph to the UI resolves it with agentGlyph(), so
// one agent looks the same everywhere.

export const TONES = {
  // Hue, chroma (OKLCH): deep and muted, so a white mark reads on every one
  indigo: [272, 0.11],
  cobalt: [252, 0.1],
  ocean: [228, 0.09],
  teal: [196, 0.08],
  forest: [158, 0.08],
  bronze: [68, 0.08],
  terracotta: [42, 0.1],
  garnet: [16, 0.11],
  plum: [328, 0.09],
  slate: [240, 0.03],
  graphite: [260, 0.008],
} as const satisfies Record<string, readonly [number, number]>
export type Tone = keyof typeof TONES
export const TONE_IDS = Object.keys(TONES) as Tone[]

// Each mark: what it stands for, its usual tone, and the role words that pick
// it (matched at the start of a word, so "account" also finds "accounting").
// Order matters: the first mark with a matching word wins.
export const MARKS = [
  {
    id: "github",
    label: "Code review & releases",
    tone: "graphite",
    words: ["github", "release", "repositor", "pull request"],
  },
  {
    id: "engineer",
    label: "Engineering",
    tone: "indigo",
    words: [
      "engineer",
      "developer",
      "software",
      "code",
      "coding",
      "programm",
      "devops",
      "frontend",
      "backend",
      "full stack",
      "qa",
    ],
  },
  {
    id: "finance",
    label: "Accounts & GST",
    tone: "forest",
    words: [
      "account",
      "finance",
      "gst",
      "bill",
      "invoice",
      "tax",
      "bookkeep",
      "ledger",
      "payroll",
      "audit",
      "expense",
      "ca ",
    ],
  },
  {
    id: "study",
    label: "Learning",
    tone: "indigo",
    words: ["study", "student", "tutor", "teacher", "learn", "exam", "course", "educat"],
  },
  {
    id: "watcher",
    label: "Scout",
    tone: "cobalt",
    words: [
      "watch",
      "scholarship",
      "admission",
      "internship",
      "monitor",
      "alert",
      "opportunit",
      "tender",
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    tone: "terracotta",
    words: ["marketing", "social media", "brand", "campaign", "seo", "growth", "ads"],
  },
  {
    id: "creator",
    label: "Creator studio",
    tone: "garnet",
    words: ["creator", "youtube", "instagram", "video", "podcast", "influencer", "reel"],
  },
  {
    id: "research",
    label: "Research",
    tone: "teal",
    words: ["research", "analyst", "investigat", "fact", "insight", "intelligence"],
  },
  {
    id: "analytics",
    label: "Analytics",
    tone: "ocean",
    words: ["data", "analytic", "metric", "report", "dashboard", "statistic"],
  },
  {
    id: "calendar",
    label: "Calendar & workspace",
    tone: "cobalt",
    words: [
      "calendar",
      "schedul",
      "meeting",
      "appointment",
      "executive",
      "secretar",
      "google",
      "workspace",
    ],
  },
  {
    id: "career",
    label: "Career",
    tone: "teal",
    words: ["career", "coach", "mentor", "resume", "cv", "profile", "interview", "job"],
  },
  {
    id: "hiring",
    label: "People & hiring",
    tone: "plum",
    words: ["hiring", "recruit", "hr", "talent", "people", "team"],
  },
  {
    id: "support",
    label: "Support",
    tone: "ocean",
    words: ["support", "helpdesk", "help desk", "service", "complaint"],
  },
  {
    id: "sales",
    label: "Sales & clients",
    tone: "bronze",
    words: ["sales", "client", "customer", "deal", "crm", "partnership", "lead"],
  },
  {
    id: "writer",
    label: "Writing",
    tone: "plum",
    words: ["writ", "content", "copy", "editor", "blog", "proposal", "author", "story"],
  },
  {
    id: "mail",
    label: "Email",
    tone: "ocean",
    words: ["email", "mail", "inbox", "correspondence", "outreach", "newsletter"],
  },
  {
    id: "legal",
    label: "Legal & compliance",
    tone: "slate",
    words: ["legal", "law", "contract", "compliance", "policy", "regulat"],
  },
  {
    id: "design",
    label: "Design",
    tone: "garnet",
    words: ["design", "ui", "ux", "graphic", "illustrat", "visual"],
  },
  {
    id: "product",
    label: "Product & strategy",
    tone: "terracotta",
    words: ["product", "strateg", "founder", "startup", "business", "plan"],
  },
  {
    id: "health",
    label: "Health",
    tone: "garnet",
    words: ["health", "fitness", "doctor", "wellness", "diet", "nutrition", "medic"],
  },
  {
    id: "travel",
    label: "Travel",
    tone: "ocean",
    words: ["travel", "trip", "itinerar", "holiday", "flight"],
  },
  {
    id: "language",
    label: "Languages",
    tone: "teal",
    words: ["translat", "language", "hindi", "telugu", "tamil", "interpret"],
  },
  {
    id: "calls",
    label: "Calls",
    tone: "forest",
    words: ["call", "phone", "voice", "receptionist", "follow-up", "follow up"],
  },
  {
    id: "security",
    label: "Security",
    tone: "graphite",
    words: ["security", "privacy", "risk", "fraud"],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    tone: "bronze",
    words: ["knowledge", "notes", "document", "librar", "wiki", "notion", "archive"],
  },
  {
    id: "operations",
    label: "Operations",
    tone: "slate",
    words: ["operation", "ops", "logistic", "process", "admin", "coordinat", "manager"],
  },
  { id: "assistant", label: "General assistant", tone: "teal", words: [] },
] as const satisfies readonly {
  id: string
  label: string
  tone: Tone
  words: readonly string[]
}[]
export type Mark = (typeof MARKS)[number]["id"]
export const MARK_IDS = MARKS.map((m) => m.id) as Mark[]
const FALLBACK: Mark = "assistant"

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// Built once: one pattern per mark, a match at the start of a word
const PATTERNS = MARKS.map(
  (mark) =>
    [
      mark.id,
      mark.words.length
        ? new RegExp(`(^|[^a-z])(${mark.words.map(escape).join("|")})`, "i")
        : null,
    ] as const
)

// The mark an agent's role suggests
export function markForRole(role: string): Mark {
  const text = ` ${role.toLowerCase()} `
  return PATTERNS.find(([, pattern]) => pattern?.test(text))?.[0] ?? FALLBACK
}

export type GlyphSpec = { mark: Mark; tone: Tone }

const isMark = (value: string): value is Mark => (MARK_IDS as string[]).includes(value)
const isTone = (value: string): value is Tone => Object.hasOwn(TONES, value)
const toneOf = (mark: Mark): Tone => MARKS.find((m) => m.id === mark)!.tone

// A chosen avatar, or null when the value isn't one ("automatic")
export function parseGlyph(value: string | null | undefined): GlyphSpec | null {
  const [mark, tone, extra] = (value ?? "").split(":")
  return extra === undefined && isMark(mark) && isTone(tone) ? { mark, tone } : null
}

export const glyphValue = ({ mark, tone }: GlyphSpec) => `${mark}:${tone}`

// The avatar an agent shows: the person's choice, else the one its role suggests
export function agentGlyph(agent: {
  glyph: string | null | undefined
  role: string | null | undefined
}): string {
  if (parseGlyph(agent.glyph)) return agent.glyph!
  const mark = markForRole(agent.role ?? "")
  return glyphValue({ mark, tone: toneOf(mark) })
}

// What the renderer draws for any value it's given (an unresolved one draws
// the general mark, never a random picture)
export function glyphSpec(value: string): GlyphSpec {
  return parseGlyph(value) ?? { mark: FALLBACK, tone: toneOf(FALLBACK) }
}

// The tile's colours, light at the top to deep at the bottom
export function toneColors(tone: Tone) {
  const [hue, chroma] = TONES[tone]
  return {
    top: `oklch(0.52 ${chroma} ${hue})`,
    bottom: `oklch(0.31 ${(chroma * 0.85).toFixed(3)} ${hue})`,
  }
}

// The same, for a row joined to an agent that may not be there (a squad's task)
export const joinedGlyph = (glyph: string | null, role: string | null) =>
  glyph === null ? null : agentGlyph({ glyph, role })
