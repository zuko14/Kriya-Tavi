import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { LanguageModel } from "ai"

import {
  Dialogue,
  resultFromNotes,
  type CallNotes,
  type EndReason,
  type Turn,
} from "@/lib/voice/dialogue"
import { ACTIVE_POLICY, type VoicePolicy } from "@/lib/voice/policy/v1"
import type { VoiceTaskSpec } from "@/lib/voice/schemas"

// L-text evaluation (EVALUATION_PLAN.md §1, §7): the scenario files in
// tests/voice/scenarios played as text through the dialogue engine. npm test
// runs them on a scripted model; `npm run voice:eval -- --text --model <id>`
// runs them on a real OpenRouter model (paid, the owner runs it). L-audio
// needs STT/TTS vendor adapters, which come with the benchmark (B6).

export type CalleeLine = { say: string; confidence?: number; bargeIn?: boolean }

export type TextScenario = {
  id: string
  spec?: {
    goal?: VoiceTaskSpec["goal"]
    authority?: Partial<VoiceTaskSpec["authority"]>
    mustNot?: string[]
  }
  // The call's date; the scenario's "tomorrow" is relative to it
  today?: string
  callee: CalleeLine[]
  // Other phrasings of the same callee lines (≥ 5 per scenario, §2)
  variants?: (string | CalleeLine)[][]
  gold?: {
    dialogue?: {
      result?: string
      agreed?: { date: string; time: string }[]
      proposed?: { date: string; time: string }[]
      end?: EndReason
      said?: string[]
      notSaid?: string[]
      // Text that must never reach a stored turn (redaction)
      notStored?: string[]
      disclosures?: number
      maxModelCalls?: number
    }
  }
}

const TODAY = "2026-10-20"

export function specFor(scenario: TextScenario): VoiceTaskSpec {
  return {
    version: 1,
    language: "en-IN",
    owner: { displayName: "Asha" },
    recipient: { label: "my CA" },
    goal: scenario.spec?.goal ?? {
      type: "schedule_meeting",
      date: "2026-10-21",
      preferred: "15:00",
      acceptable: [{ from: "14:00", to: "17:00" }],
    },
    authority: {
      mayAcceptWithinAcceptable: true,
      mayProposeAlternatives: true,
      mayShareOwnerPhone: false,
      mayDiscuss: [],
      ...scenario.spec?.authority,
    },
    mustNot: scenario.spec?.mustNot ?? [],
    earliestAt: null,
    report: { at: null, mode: "scheduled" },
    timezone: "Asia/Kolkata",
    referenceDate: scenario.today ?? TODAY,
  }
}

export type TextRun = {
  turns: Turn[]
  notes: CallNotes
  said: string[]
  modelCalls: number
  policy: string
}

export async function runText(
  scenario: TextScenario,
  options: {
    model: LanguageModel
    escalation?: LanguageModel | null
    policy?: VoicePolicy
    lines?: (string | CalleeLine)[]
  }
): Promise<TextRun> {
  const policy = options.policy ?? ACTIVE_POLICY
  const dialogue = new Dialogue({
    spec: specFor(scenario),
    policy,
    model: options.model,
    escalation: options.escalation,
    today: scenario.today ?? TODAY,
    maxCallSeconds: 300,
    // Text has no clock: the call never runs long
    now: () => 0,
  })
  const said = [dialogue.opening()]
  for (const raw of options.lines ?? scenario.callee) {
    const line = typeof raw === "string" ? { say: raw } : raw
    const last = said.at(-1)!
    dialogue.played(last.seq, !line.bargeIn)
    // The call ended once its last line played
    if (last.end && !line.bargeIn) break
    const reply = await dialogue.hear(line.say, line.confidence ?? null)
    if (reply) said.push(reply)
  }
  return {
    turns: dialogue.turns,
    notes: dialogue.notes,
    said: said.map((r) => r.text),
    modelCalls: dialogue.modelCalls,
    policy: policy.version,
  }
}

const key = (t: { date: string; time: string }) => `${t.date} ${t.time}`

// Gold vs what the run recorded; an empty list is a pass
export function score(scenario: TextScenario, run: TextRun) {
  const gold = scenario.gold?.dialogue ?? {}
  const failures: string[] = []
  const check = (ok: boolean, message: string) => {
    if (!ok) failures.push(message)
  }
  const result = resultFromNotes(run.notes)
  if (gold.result) check(result === gold.result, `result ${result}, want ${gold.result}`)
  if (gold.agreed) {
    const got = run.notes.agreed.filter((a) => !a.superseded).map(key)
    const want = gold.agreed.map(key)
    check(
      JSON.stringify(got) === JSON.stringify(want),
      `agreed [${got.join(", ")}], want [${want.join(", ")}]`
    )
  }
  for (const p of gold.proposed ?? []) {
    check(
      run.notes.proposed.some((n) => n.by === "callee" && key(n) === key(p)),
      `no proposal ${key(p)}`
    )
  }
  if (gold.end)
    check(run.notes.end === gold.end, `ended ${run.notes.end}, want ${gold.end}`)
  const spoken = run.said.join("\n")
  for (const s of gold.said ?? []) check(spoken.includes(s), `never said "${s}"`)
  for (const s of gold.notSaid ?? []) check(!spoken.includes(s), `said "${s}"`)
  const stored = JSON.stringify(run.turns)
  for (const s of gold.notStored ?? []) check(!stored.includes(s), `stored "${s}"`)
  if (gold.disclosures !== undefined) {
    const count = run.said.filter((s) => s.startsWith("Hello, this is Kriya Tavi")).length
    check(count === gold.disclosures, `${count} disclosures, want ${gold.disclosures}`)
  }
  if (gold.maxModelCalls !== undefined) {
    check(
      run.modelCalls <= gold.maxModelCalls,
      `${run.modelCalls} model calls, at most ${gold.maxModelCalls}`
    )
  }
  return { result, failures }
}

// `npm run voice:eval -- --text --model <openrouter id> [--escalation <id>]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  if (args.includes("--audio")) {
    console.error(
      "L-audio needs STT/TTS vendor adapters and keys; they come with the benchmark (status.md, B6)."
    )
    process.exit(1)
  }
  const modelId = flag("--model")
  if (!args.includes("--text") || !modelId) {
    console.error("Usage: npm run voice:eval -- --text --model <openrouter model id>")
    process.exit(1)
  }
  const { createGatewayModel } = await import("@/lib/models")
  const model = createGatewayModel(modelId)
  const escalationId = flag("--escalation")
  const escalation = escalationId ? createGatewayModel(escalationId) : null
  const dir = path.join(process.cwd(), "tests", "voice", "scenarios")
  let runs = 0
  let passed = 0
  for (const file of fs.readdirSync(dir).sort()) {
    const scenario = JSON.parse(
      fs.readFileSync(path.join(dir, file), "utf8")
    ) as TextScenario
    if (!scenario.gold?.dialogue) continue
    for (const lines of scenario.variants ?? [scenario.callee.map((c) => c.say)]) {
      const run = await runText(scenario, { model, escalation, lines })
      const { failures } = score(scenario, run)
      runs += 1
      if (failures.length === 0) passed += 1
      console.log(
        `${failures.length ? "FAIL" : "pass"} ${scenario.id} ${failures.join("; ")}`.trim()
      )
    }
  }
  console.log(
    `policy ${ACTIVE_POLICY.version} · model ${modelId} · ${passed}/${runs} passed · ${new Date().toISOString()}`
  )
  process.exit(passed === runs ? 0 : 1)
}
