import fs from "node:fs"
import path from "node:path"

import type { MemoryKind } from "@/db/schema"

// Scenario seeds for the evaluation suites (docs/agent-platform/
// TEST_AND_EVALUATION.md §4) and the long threads built from them.
//
// An AS-CTX seed holds three real topics (the person's question and the
// agent's answer). buildThread walks them in turn, 14 times, with follow-up
// questions, so every thread has 42 person turns. The threads are synthetic
// and deterministic: they measure how prompt size grows with a thread, not
// answer quality. Fictional people only.

export type Seed = {
  id: string
  role: string
  title: string
  agent: { name: string; role: string; instructions: string | null }
  memories: {
    content: string
    kind: MemoryKind
    slot?: string
    shared?: boolean
    source?: "user"
  }[]
  topics: { ask: string; answer: string }[]
  // The person's message the measured task answers
  ask: string
}

export function loadSuite(suite: string): Seed[] {
  const dir = path.join(process.cwd(), "tests", "eval", "scenarios", suite)
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Seed)
}

export const ROUNDS = 14

// Round 0 asks the topic's own question; later rounds follow up on it
const FOLLOW_UPS = [
  "Can you make that shorter, in points?",
  "What should I do first this week?",
  "What if it slips by a week?",
  "Any risks I'm missing?",
  "Remind me what we decided about this.",
  "Okay, and what's the next step after that?",
  "Can you check the numbers once more?",
  "Explain that like I'm new to this.",
  "What would you change if money were tighter?",
  "Give me the same as a checklist.",
  "Is there anything I should ask someone else about?",
  "Put it in a message I can forward.",
  "Thanks. One more look at this before we move on.",
]

const LEADS = [
  "",
  "In short:",
  "This week:",
  "If it slips:",
  "Risks to watch:",
  "What we decided:",
  "Next step:",
  "Checked again:",
  "Simply put:",
  "On a tighter budget:",
  "As a checklist:",
  "Worth asking someone else:",
  "Ready to forward:",
  "One more look:",
]

// The answer again, its sentences rotated, so each reply differs but keeps
// the topic's length and facts
function reply(answer: string, round: number) {
  if (round === 0) return answer
  const sentences = answer.split(/(?<=[.!?])\s+/)
  const shift = round % sentences.length
  return `${LEADS[round]} ${[...sentences.slice(shift), ...sentences.slice(0, shift)].join(" ")}`
}

export type Turn = { role: "user" | "assistant"; text: string }

export function buildThread(seed: Seed): Turn[] {
  const turns: Turn[] = []
  for (let round = 0; round < ROUNDS; round++) {
    for (const topic of seed.topics) {
      turns.push({
        role: "user",
        text: round === 0 ? topic.ask : FOLLOW_UPS[round - 1],
      })
      turns.push({ role: "assistant", text: reply(topic.answer, round) })
    }
  }
  return turns
}
