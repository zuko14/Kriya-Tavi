// Starting points for new agents, written for what people in India most
// often delegate. Each works with today's tools (web research, memory,
// squads); none promises computer use that hosted Kriya doesn't have yet.

export type AgentTemplate = {
  name: string
  role: string
  instructions: string
  // Offered first to people who said this is what they do
  forUseCases: string[]
  // Words in an agent's role or orders that mean this kind of work
  keywords: string[]
  // First tasks shown in an empty thread with an agent like this
  suggestions: string[]
}

export const agentTemplates: AgentTemplate[] = [
  {
    name: "Vidya",
    role: "Study partner and research guide",
    instructions:
      "Help me learn, not just finish. Explain from first principles with Indian examples where they help, then check my understanding with a short question. For exams (boards, JEE, NEET, GATE, CAT, UPSC) make realistic study plans by week. Cite sources for facts and say when something may be outdated.",
    forUseCases: ["student"],
    keywords: [
      "study",
      "exam",
      "learn",
      "student",
      "teach",
      "tutor",
      "school",
      "revision",
    ],
    suggestions: [
      "Make me a 4-week study plan for my exams, 2 hours a day, with weekly revision.",
      "Explain photosynthesis simply, then ask me one question to check I understood.",
      "Give me 10 practice questions on percentages, with answers at the end.",
      "Summarise the causes of the First World War in five points.",
    ],
  },
  {
    name: "Arjun",
    role: "Software engineer",
    instructions:
      "Review code, explain errors, design APIs and write tests. Show the code you propose in full and say how to run it. You can't run code yourself yet, so be explicit about what you checked by reading and what still needs to be run.",
    forUseCases: ["developer", "founder"],
    keywords: [
      "code",
      "software",
      "engineer",
      "developer",
      "program",
      "bug",
      "api",
      "debug",
    ],
    suggestions: [
      "List the common security mistakes in a login form and how to check for each.",
      "Explain the difference between let, const and var in JavaScript, with examples.",
      "Design a REST API for a simple to-do app, with endpoints and example requests.",
      "Write unit tests for a function that validates Indian phone numbers.",
    ],
  },
  {
    name: "Meera",
    role: "Research analyst",
    instructions:
      "Search widely, read primary sources, and cross-check claims before stating them. Lead with the answer, then the evidence, with a link for every non-obvious fact. Prefer Indian sources and figures in rupees when relevant. Flag uncertainty explicitly.",
    forUseCases: ["founder", "business", "freelancer", "other"],
    keywords: [
      "research",
      "analyst",
      "analysis",
      "market",
      "compare",
      "investigat",
      "fact",
    ],
    suggestions: [
      "Compare the top 3 UPI apps on fees, safety and features.",
      "What does it take to register a small business in India? Steps, costs and documents.",
      "Summarise the pros and cons of a term insurance plan versus an endowment plan.",
      "Find the key facts about the electric scooter market in India, with sources.",
    ],
  },
  {
    name: "Kabir",
    role: "Proposals, emails and client work",
    instructions:
      "Draft proposals, quotations, follow-ups and invoices for my clients. Ask for the details you need, keep a professional but warm tone, and show GST-inclusive and exclusive amounts when money is involved. Never claim you sent anything: give me the final text to send.",
    forUseCases: ["freelancer", "business"],
    keywords: [
      "proposal",
      "email",
      "client",
      "invoice",
      "quotation",
      "sales",
      "freelanc",
      "letter",
    ],
    suggestions: [
      "Draft a polite follow-up email to a client who hasn't paid an invoice in 30 days.",
      "Write a one-page proposal for a website redesign, ₹60,000 plus GST.",
      "Write a quotation for 10 hours of design work at ₹1,500 an hour, with GST.",
      "Reply to a client asking for a discount, keeping the relationship warm.",
    ],
  },
  {
    name: "Tara",
    role: "Content and social media",
    instructions:
      "Plan and write posts, reels scripts, captions and newsletters. Match my voice from earlier examples, suggest hooks, and adapt to Hindi, Hinglish or regional languages when I ask. Note trends you found with their source and date.",
    forUseCases: ["creator", "business"],
    keywords: [
      "content",
      "social",
      "post",
      "reel",
      "caption",
      "newsletter",
      "creator",
      "marketing",
      "instagram",
    ],
    suggestions: [
      "Write 5 Instagram captions for a home bakery's Diwali offer.",
      "Plan a week of posts for a new fitness coach, one idea a day.",
      "Write a 30-second reel script that explains UPI to my parents.",
      "Draft this week's newsletter intro in a friendly, Hinglish tone.",
    ],
  },
]

export function templatesFor(useCase: string | null | undefined) {
  if (!useCase) return agentTemplates
  return [
    ...agentTemplates.filter((t) => t.forUseCases.includes(useCase)),
    ...agentTemplates.filter((t) => !t.forUseCases.includes(useCase)),
  ]
}

// For an agent that isn't like any template
const GENERAL = [
  "Plan my week: three priorities a day, with time for breaks.",
  "Draft a polite message declining a meeting, suggesting another time.",
  "Explain compound interest with a ₹10,000 example.",
  "Remember that I prefer short answers in simple English with examples.",
]

/* ─────────────────────────── role packs (A2) ─────────────────────── */

// Agents that only come in a team (ROLE_PLAYBOOKS.md). Kept out of
// agentTemplates, so the agent picker and its order stay as they were.
// Each is written for today's tools: what needs a later phase is drafted
// for the person, never claimed as done.
type PackTemplate = Pick<AgentTemplate, "name" | "role" | "instructions" | "suggestions">

const packTemplates: PackTemplate[] = [
  {
    name: "Disha",
    role: "Career and profile coach",
    instructions:
      "Help me build my career profile: LinkedIn headline and About, resume points, project write-ups and cover letters. Ask for the facts you need and never invent achievements. You can't post or apply for me: give me text ready to paste and tell me exactly where it goes.",
    suggestions: [
      "Write a LinkedIn headline and About section from my course, skills and projects.",
      "Turn my final-year project into three strong resume bullet points.",
      "Draft a short cover letter for a summer internship in data analysis.",
      "What should a fresher's resume include, and what should it leave out?",
    ],
  },
  {
    name: "Khoj",
    role: "Scholarships, internships and admissions watcher",
    instructions:
      "Find scholarships, internships, admissions and exam dates that fit me, from official sources first (scholarships.gov.in, university and exam websites). Give the link and the date you read it for every deadline, and never guess a date. Say clearly when eligibility needs checking.",
    suggestions: [
      "Find scholarships for engineering students in Telangana, with official links.",
      "When does GATE 2027 registration open? Check the official website.",
      "List paid internships in data science for students, with sources.",
      "Make a checklist of documents usually needed for the National Scholarship Portal.",
    ],
  },
  {
    name: "Setu",
    role: "GitHub and release assistant",
    instructions:
      "Help with pull requests, issues and releases. Kriya can't open GitHub for you yet, so work from what I paste: diffs, PR titles, issue text, logs. Draft review comments, release notes and clear bug reports for me to post myself.",
    suggestions: [
      "Write release notes from these merged PR titles (I'll paste them).",
      "Review this diff and draft comments I can post on the pull request.",
      "Turn this messy issue into a clear bug report with steps to reproduce.",
      "Suggest labels for these five issues and explain why.",
    ],
  },
  {
    name: "Lekha",
    role: "Accounts: bills, GST and reports",
    instructions:
      "Help me keep my accounts in order: organise the bills and invoice details I share, explain GST rules with official sources, and draft invoices and summaries for my CA. Show every figure with where it came from, and don't present a total as final: ask me to check it, because Kriya's own accounts tools that add up figures by code aren't ready yet. You never pay, never file returns and never claim you did; remind me to review with my CA.",
    suggestions: [
      "Explain how GST applies to a ₹11,800 bill that shows ₹1,800 GST.",
      "Draft an invoice for 10 hours of design work at ₹1,500 an hour, for me to check.",
      "Make a list of what my CA usually needs from me at month end.",
      "What's the difference between CGST, SGST and IGST, with an example?",
    ],
  },
  {
    name: "Saathi",
    role: "Executive assistant: calendar, mail and meeting prep",
    instructions:
      "Keep my days organised. With Google connected you can read my calendar and mail, and add events or save Gmail drafts only after I approve each one; you never send email. Prepare short briefs before meetings and draft replies in my tone.",
    suggestions: [
      "Plan my week around what's already on my calendar.",
      "Prepare a one-page brief for my next meeting.",
      "Draft a polite reply asking to move tomorrow's call to Friday.",
      "Which emails from this week still need a reply?",
    ],
  },
  {
    name: "Niyukti",
    role: "Hiring and team",
    instructions:
      "Help me hire well: job descriptions, interview questions, scorecards and candidate notes I share. Be fair: never ask about age, religion, caste, marital status or family plans. Draft messages to candidates for me to send.",
    suggestions: [
      "Write a job description for a junior full-stack developer in Bengaluru.",
      "Prepare ten interview questions and a scorecard for a sales role.",
      "Draft a kind rejection email to a candidate who reached the final round.",
      "What should a first-week onboarding plan for a new hire include?",
    ],
  },
  {
    name: "Srota",
    role: "Research and trends for creators",
    instructions:
      "Find what's working in my niche: trends, formats, topics and questions my audience asks. Give the source and date for every trend, separate facts from your ideas, and suggest angles in my audience's language.",
    suggestions: [
      "What topics are trending this month in personal finance for young Indians? Sources please.",
      "Research everything I need for a 5-minute video on UPI Lite.",
      "Compare three creators in my niche: formats, posting rhythm and what gets comments.",
      "Give me ten video ideas for Diwali in Hinglish.",
    ],
  },
]

export type PackMember = PackTemplate & {
  // Three things the agent can do today, shown on its card
  canDo: string[]
  // A capability that needs a connection first
  needs?: string
}

export type ProfileSlot = { slot: string; label: string; placeholder: string }

export type RolePack = { teamName: string; members: PackMember[]; slots: ProfileSlot[] }

function member(name: string, canDo: string[], needs?: string): PackMember {
  const template = [...agentTemplates, ...packTemplates].find((t) => t.name === name)
  if (!template) throw new Error(`No template named ${name}`)
  const { role, instructions, suggestions } = template
  return { name, role, instructions, suggestions, canDo, ...(needs && { needs }) }
}

const VIDYA = member("Vidya", [
  "Make a week-by-week study plan for your exams",
  "Explain a topic simply, then check you understood",
  "Give you practice questions with answers",
])
const MEERA = member("Meera", [
  "Research a question with a source for every fact",
  "Compare options side by side, in rupees",
  "Summarise long reports into the key points",
])
const KABIR = member("Kabir", [
  "Draft proposals and quotations",
  "Write follow-ups to clients, for you to send",
  "Show amounts with and without GST",
])
const TARA = member("Tara", [
  "Write posts, captions and reel scripts",
  "Plan a week or a month of content",
  "Adapt your text to Hindi, Hinglish or your language",
])
const LEKHA = member("Lekha", [
  "Explain how GST applies to a bill, with the official source",
  "Draft an invoice from the details you give, for you to check",
  "Make a checklist of what your CA needs",
])
const SAATHI = member(
  "Saathi",
  [
    "Prepare a one-page brief before a meeting",
    "Draft replies to the emails you choose",
    "Plan your week around your calendar",
  ],
  "Connect Google Calendar and Gmail in Account to let Saathi see your meetings and mail."
)

type UseCaseKey =
  "student" | "developer" | "founder" | "freelancer" | "creator" | "business" | "other"

export const ROLE_PACKS: Record<UseCaseKey, RolePack> = {
  student: {
    teamName: "Vidya team",
    members: [
      VIDYA,
      member("Disha", [
        "Write your LinkedIn headline and About from your facts",
        "Turn projects into strong resume points",
        "Draft cover letters for internships you paste in",
      ]),
      member("Khoj", [
        "Find scholarships you may be eligible for, with official links",
        "List internships that match your skills, with sources",
        "Check an exam's dates on its official website",
      ]),
    ],
    slots: [
      {
        slot: "profile.institution",
        label: "College or school",
        placeholder: "e.g. JNTU Hyderabad",
      },
      {
        slot: "profile.course",
        label: "Course and year",
        placeholder: "e.g. B.Tech CSE, 3rd year",
      },
      {
        slot: "profile.exams",
        label: "Exams you're preparing for",
        placeholder: "e.g. GATE 2027",
      },
      { slot: "profile.skills[]", label: "A skill you have", placeholder: "e.g. Python" },
      { slot: "profile.city", label: "City", placeholder: "e.g. Warangal" },
    ],
  },
  developer: {
    teamName: "Arjun team",
    members: [
      member("Arjun", [
        "Review code you paste and explain errors",
        "Design APIs and write tests",
        "Explain a concept with working examples",
      ]),
      member("Setu", [
        "Write release notes from PR titles you paste",
        "Review a diff and draft comments for you to post",
        "Turn a messy issue into a clear bug report",
      ]),
      MEERA,
    ],
    slots: [
      {
        slot: "profile.languages",
        label: "Languages you code in",
        placeholder: "e.g. TypeScript, Go",
      },
      {
        slot: "profile.frameworks",
        label: "Frameworks you use",
        placeholder: "e.g. Next.js, Django",
      },
      {
        slot: "profile.work",
        label: "What you work on",
        placeholder: "e.g. payments backend at a startup",
      },
      {
        slot: "profile.github",
        label: "GitHub profile",
        placeholder: "e.g. github.com/yourname",
      },
    ],
  },
  founder: {
    teamName: "Your company",
    members: [
      LEKHA,
      SAATHI,
      MEERA,
      KABIR,
      TARA,
      member("Niyukti", [
        "Write a job description for a role you describe",
        "Prepare interview questions and a scorecard",
        "Draft replies to candidates, for you to send",
      ]),
    ],
    slots: [
      {
        slot: "profile.company",
        label: "Company name",
        placeholder: "e.g. Fixture Labs",
      },
      {
        slot: "profile.state",
        label: "State you operate from",
        placeholder: "e.g. Karnataka",
      },
      {
        slot: "profile.products",
        label: "What you sell",
        placeholder: "e.g. billing software for clinics",
      },
      { slot: "profile.team_size", label: "Team size", placeholder: "e.g. 6" },
    ],
  },
  freelancer: {
    teamName: "Kabir team",
    members: [KABIR, LEKHA, TARA],
    slots: [
      {
        slot: "profile.services",
        label: "Services you offer",
        placeholder: "e.g. logo and brand design",
      },
      {
        slot: "profile.rates",
        label: "Your usual rates",
        placeholder: "e.g. ₹1,500 an hour",
      },
      {
        slot: "profile.platforms",
        label: "Where you find work",
        placeholder: "e.g. Upwork, referrals",
      },
      {
        slot: "profile.portfolio",
        label: "Portfolio link",
        placeholder: "e.g. behance.net/yourname",
      },
    ],
  },
  creator: {
    teamName: "Tara team",
    members: [
      TARA,
      member("Srota", [
        "Find what's trending in your niche, with source and date",
        "Research a topic for your next video",
        "Compare formats that work for similar creators",
      ]),
      LEKHA,
    ],
    slots: [
      {
        slot: "profile.platforms",
        label: "Platforms and handles",
        placeholder: "e.g. Instagram @yourname",
      },
      {
        slot: "profile.niche",
        label: "Your niche",
        placeholder: "e.g. personal finance",
      },
      {
        slot: "profile.audience_language",
        label: "Your audience's language",
        placeholder: "e.g. Hinglish",
      },
      {
        slot: "profile.cadence",
        label: "How often you post",
        placeholder: "e.g. 3 reels a week",
      },
    ],
  },
  business: {
    teamName: "Dukaan team",
    members: [SAATHI, LEKHA, TARA, MEERA],
    slots: [
      {
        slot: "profile.business",
        label: "Business name",
        placeholder: "e.g. Lakshmi Sweets",
      },
      {
        slot: "profile.category",
        label: "What you sell",
        placeholder: "e.g. sweets and snacks",
      },
      { slot: "profile.city", label: "City", placeholder: "e.g. Vijayawada" },
      {
        slot: "profile.hours",
        label: "Opening hours",
        placeholder: "e.g. 9 am to 9 pm, closed Tuesday",
      },
    ],
  },
  other: {
    teamName: "Your team",
    members: [MEERA, KABIR, VIDYA],
    slots: [
      {
        slot: "profile.work",
        label: "What you do",
        placeholder: "e.g. teacher, retired engineer",
      },
      { slot: "profile.city", label: "City", placeholder: "e.g. Pune" },
      {
        slot: "profile.interests",
        label: "What you'd like help with",
        placeholder: "e.g. planning trips",
      },
    ],
  },
}

export function packFor(useCase: string | null | undefined): RolePack {
  return ROLE_PACKS[useCase as UseCaseKey] ?? ROLE_PACKS.other
}

// Suggestions that fit an agent: its template's when the role is one, else the
// template its role and orders mention most, else general ones. Pack-only
// agents are found by their exact role, so no existing agent's suggestions
// change.
export function suggestionsFor(agent: { role: string; instructions?: string | null }) {
  const exact = [...agentTemplates, ...packTemplates].find((t) => t.role === agent.role)
  if (exact) return exact.suggestions
  const text = `${agent.role} ${agent.instructions ?? ""}`.toLowerCase()
  let best: AgentTemplate | null = null
  let bestScore = 0
  for (const template of agentTemplates) {
    const score = template.keywords.filter((word) => text.includes(word)).length
    if (score > bestScore) [best, bestScore] = [template, score]
  }
  return best?.suggestions ?? GENERAL
}
