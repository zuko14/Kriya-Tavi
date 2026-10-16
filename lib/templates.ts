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

// Suggestions that fit an agent: its template's when the role is one, else the
// template its role and orders mention most, else general ones
export function suggestionsFor(agent: { role: string; instructions?: string | null }) {
  const exact = agentTemplates.find((t) => t.role === agent.role)
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
