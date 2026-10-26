// Giving the callee a phone number the owner asked Tavi to share, and every
// follow-up about it: "repeat", "slower", "the last four digits?", "after 98
// what came?", "wait, let me get a pen" and the callee's read-back. All of
// it is code over the stored digits: the model never sees the number (turns
// store it withheld) and can't speak one (its replies are redacted), so a
// digit can't be wrong or invented. Requests are understood in English,
// Hindi, Telugu and Hinglish, in Latin or native script, because callers
// mix them; Tavi answers in English, the call's language (D-11).
// ponytail: English answers only; spoken Hindi/Telugu digits wait on D-21.

export type NumberRequest =
  | { kind: "repeat"; slow: boolean }
  | { kind: "last" | "first"; n: number | null }
  | { kind: "after" | "before"; digits: string }
  | { kind: "check"; digits: string }
  | { kind: "wait" }

// What to say, and the same words with every digit withheld for the stored
// turn. readBack: how the callee's read-back compared, when it was one
export type NumberAnswer = {
  text: string
  stored: string
  readBack?: "correct" | "wrong"
}

const WITHHELD = "[number withheld]"
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
]

// Digits as said, in English, Hindi and Telugu (Latin and native script)
const DIGIT: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  shunya: "0",
  shoonya: "0",
  sunya: "0",
  ek: "1",
  do: "2",
  teen: "3",
  tin: "3",
  char: "4",
  chaar: "4",
  paanch: "5",
  panch: "5",
  chhah: "6",
  chhe: "6",
  chheh: "6",
  chah: "6",
  che: "6",
  saat: "7",
  sat: "7",
  aath: "8",
  aat: "8",
  nau: "9",
  sunna: "0",
  sunnaa: "0",
  okati: "1",
  okkati: "1",
  rendu: "2",
  moodu: "3",
  mudu: "3",
  naalugu: "4",
  nalugu: "4",
  aidu: "5",
  aidhu: "5",
  ayidu: "5",
  aaru: "6",
  aru: "6",
  edu: "7",
  eedu: "7",
  yedu: "7",
  enimidi: "8",
  yenimidi: "8",
  tommidi: "9",
  thommidi: "9",
  शून्य: "0",
  एक: "1",
  दो: "2",
  तीन: "3",
  चार: "4",
  पांच: "5",
  पाँच: "5",
  छह: "6",
  छः: "6",
  छे: "6",
  सात: "7",
  आठ: "8",
  नौ: "9",
  సున్నా: "0",
  సున్న: "0",
  ఒకటి: "1",
  రెండు: "2",
  మూడు: "3",
  నాలుగు: "4",
  ఐదు: "5",
  అయిదు: "5",
  ఆరు: "6",
  ఏడు: "7",
  ఎనిమిది: "8",
  తొమ్మిది: "9",
}
// Also everyday words ("do", "sat", "oh"): a digit only next to another one
const AMBIGUOUS = new Set([
  "oh",
  "do",
  "teen",
  "tin",
  "char",
  "sat",
  "che",
  "chah",
  "aat",
  "aru",
  "edu",
])
const TEENS: Record<string, string> = {
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  das: "10",
  padi: "10",
}
const TENS: Record<string, string> = {
  twenty: "2",
  thirty: "3",
  forty: "4",
  fifty: "5",
  sixty: "6",
  seventy: "7",
  eighty: "8",
  ninety: "9",
}
const TIMES: Record<string, number> = { double: 2, dabal: 2, triple: 3 }

// Native-script numerals as ASCII digits
const asciiDigits = (text: string) =>
  text.replace(/[०-९౦-౯]/g, (c) =>
    String(c.charCodeAt(0) - (c.charCodeAt(0) >= 0x0c66 ? 0x0c66 : 0x0966))
  )

type Token = { word: string; at: number; end: number }
type Run = { digits: string; at: number; end: number }

const tokens = (text: string): Token[] =>
  [...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((m) => ({
    word: m[0],
    at: m.index,
    end: m.index + m[0].length,
  }))

// Runs of spoken digits: "98 765", "nine eight seven", "double nine",
// "ninety eight", "nau aath", "తొమ్మిది ఎనిమిది"
function runs(text: string): Run[] {
  const found: Run[] = []
  let run: (Run & { sure: boolean; count: number }) | null = null
  let times = 1
  const flush = () => {
    if (run && (run.sure || run.count > 1)) found.push(run)
    run = null
  }
  const list = tokens(text)
  for (let i = 0; i < list.length; i++) {
    const { word, at, end } = list[i]
    if (TIMES[word]) {
      times = TIMES[word]
      continue
    }
    let digits: string | null = null
    let sure = true
    if (/^\d+$/.test(word)) digits = word
    else if (TEENS[word]) digits = TEENS[word]
    else if (TENS[word]) {
      const unit = list[i + 1] && DIGIT[list[i + 1].word]
      digits = TENS[word] + (unit && unit !== "0" ? unit : "0")
      if (unit && unit !== "0") i++
    } else if (DIGIT[word]) {
      digits = DIGIT[word]
      sure = !AMBIGUOUS.has(word)
    }
    if (digits === null) {
      flush()
      times = 1
      continue
    }
    digits = digits.repeat(times)
    times = 1
    if (run) {
      run.digits += digits
      run.end = end
      run.sure ||= sure
      run.count += 1
    } else run = { digits, at, end, sure, count: 1 }
  }
  flush()
  return found
}

// A count said after "last" or "first": "four", "4", "chaar", "naalugu"
function countAfter(text: string, from: number): number | null {
  for (const t of tokens(text.slice(from)).slice(0, 3)) {
    const d = /^\d{1,2}$/.test(t.word) ? t.word : (TEENS[t.word] ?? DIGIT[t.word])
    if (d) return Number(d)
  }
  return null
}

// \b is ASCII-only, so native-script words are matched without it
const re = (latin: string, native = "") =>
  new RegExp(`\\b(?:${latin})\\b${native ? `|${native}` : ""}`)

const NUMBER = re(
  "number|numbers|digit|digits|nambar|numbar|ank|ankelu|ankalu",
  "नंबर|नम्बर|अंक|నంబర్|నెంబర్|అంకెలు|అంకె"
)
const WAIT = re(
  "wait|hold on|hang on|one (?:sec|second|minute|moment)|just a (?:sec|second|minute|moment)|ek (?:sec|second|minute|min|minit)|ruko|rukiye|ruk jao|oka nimisham|okka nimisham|aagandi|aagu|pen",
  "रुको|रुकिए|एक मिनट|ఆగండి|ఒక్క నిమిషం|ఒక నిమిషం"
)
const SLOW = re(
  "slow|slower|slowly|dheere|dhire|dheeme|aaram se|nemmadiga|nemmadhiga|nidhanamga",
  "धीरे|నెమ్మదిగా"
)
const LAST = re(
  "last|aakhri|akhri|aakhir|antim|chivari|chivara|chivarlo",
  "आखिरी|अंतिम|చివరి"
)
const FIRST = re(
  "first|starting|pehle|pehla|pahle|shuru|shuruat|modati|modhati|modalu",
  "पहले|शुरू|మొదటి"
)
const AFTER = re(
  "after|baad|tarvata|taruvata|tarwata|taravata|tarvatha|taruvatha|tarwatha",
  "बाद|తర్వాత|తరువాత"
)
const BEFORE = re(
  "before|(?:se|ke) (?:pehle|pahle)|mundu|mundhu|mundara|mundhara",
  "से पहले|के पहले|ముందు"
)
const REPEAT = re(
  "repeat|again|once more|one more time|come again|pardon|didn'?t (?:get|catch|hear)|missed|what (?:was|is|'s) (?:the|that|his|her) number|give me (?:the|that|his|her) number|number (?:please|kya|batao|bataiye|boliye|bolo|cheppandi|chepandi|chepu)|phir|fir|dobara|dubara|ek baar aur|kya bola|kya kaha|malli|marokasari|inkosari|inko sari|samajh nahi|ardham kaledu|vinapadaledu",
  "फिर से|दोबारा|మళ్ళీ|మళ్లీ|ఇంకోసారి|మరోసారి"
)
// A one-word "Sorry?" or "What?" asks to hear it again
const HUH = /^\W*(?:sorry|what|huh|kya|enti|emi|ఏంటి|क्या)\W*$/

// The run beside a keyword: English says the digits after "after", Hindi
// and Telugu before "ke baad" / "tarvata"; the other side if none
function beside(found: Run[], at: number, end: number, ahead: boolean) {
  const after = found.find((r) => r.at >= end)
  const before = found.filter((r) => r.end <= at).at(-1)
  return ahead ? (after ?? before) : (before ?? after)
}

// What the callee wants about the number, or null. While Tavi is giving the
// number (explicit = false) anything goes; elsewhere in the call the
// callee must name the number, so "after 3" about a meeting time is a time
export function parseNumberRequest(
  text: string,
  { explicit = false } = {}
): NumberRequest | null {
  const t = asciiDigits(text.toLowerCase())
  if (explicit && !NUMBER.test(t)) return null
  if (WAIT.test(t)) return { kind: "wait" }
  const found = runs(t)
  for (const [pattern, kind] of [
    [BEFORE, "before"],
    [AFTER, "after"],
  ] as const) {
    const m = pattern.exec(t)
    if (!m) continue
    const run = beside(
      found,
      m.index,
      m.index + m[0].length,
      /^(after|before)$/.test(m[0])
    )
    if (run) return { kind, digits: run.digits }
  }
  for (const [pattern, kind] of [
    [LAST, "last"],
    [FIRST, "first"],
  ] as const) {
    const m = pattern.exec(t)
    if (m) return { kind, n: countAfter(t, m.index + m[0].length) }
  }
  if (SLOW.test(t)) return { kind: "repeat", slow: true }
  if (REPEAT.test(t) || HUH.test(t)) return { kind: "repeat", slow: false }
  const said = found
    .filter((r) => r.digits.length >= 3)
    .sort((a, b) => b.digits.length - a.digits.length)[0]
  return said ? { kind: "check", digits: said.digits } : null
}

/* ──────────────────────────── speaking ──────────────────────────── */

// The digits Tavi gives: an Indian mobile without +91 or 0, as Indians
// say it; anything else as stored
export function nationalDigits(phone: string) {
  const d = phone.replace(/\D/g, "")
  if (/^91[6-9]\d{9}$/.test(d)) return d.slice(2)
  if (/^0[6-9]\d{9}$/.test(d)) return d.slice(1)
  return d
}

// 10 digits as 5 + 5 ("98765 43210"); otherwise groups of up to 4 from the
// end, a lone leading digit joining the next group
export function groups(digits: string) {
  if (digits.length === 10) return [digits.slice(0, 5), digits.slice(5)]
  const out: string[] = []
  for (let end = digits.length; end > 0; end -= 4)
    out.unshift(digits.slice(Math.max(0, end - 4), end))
  if (out.length > 1 && out[0].length === 1) out.splice(0, 2, out[0] + out[1])
  return out
}

const plain = (digits: string) => [...digits].map((d) => WORDS[Number(d)]).join(" ")

// "nine eight seven six five, four three two one zero"; slow: a pause
// after every digit and a longer one between groups
export function spoken(digits: string, slow = false) {
  return groups(digits)
    .map((g) => [...g].map((d) => WORDS[Number(d)]).join(slow ? ", " : " "))
    .join(slow ? ". " : ", ")
}

const COUNT = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
]

// A sentence made of words and digits: the digits are spoken, and withheld
// in the stored turn
type Part = string | { digits: string; slow?: boolean; grouped?: boolean }
function answer(parts: Part[], readBack?: NumberAnswer["readBack"]): NumberAnswer {
  const text = parts
    .map((p) =>
      typeof p === "string" ? p : p.grouped ? spoken(p.digits, p.slow) : plain(p.digits)
    )
    .join("")
  const stored = parts.map((p) => (typeof p === "string" ? p : WITHHELD)).join("")
  const upper = (s: string) => s[0].toUpperCase() + s.slice(1)
  return { text: upper(text), stored: upper(stored), ...(readBack && { readBack }) }
}

const whole = (digits: string, slow = false) => ({ digits, slow, grouped: true })

// Tavi's first words about the number
export const giveNumber = (owner: string, label: string, digits: string) =>
  answer([
    `${owner} asked me to give you ${label}'s number. It's `,
    whole(digits),
    ". Shall I repeat it?",
  ])

// The answer to one request, from the digits alone
export function answerNumberRequest(
  digits: string,
  label: string,
  request: NumberRequest,
  { slow = false, unsure = false } = {}
): NumberAnswer {
  const all = whole(digits, slow)
  switch (request.kind) {
    case "wait":
      return answer(["Sure, take your time. Tell me when you're ready."])
    case "repeat":
      return request.slow
        ? answer([`Slowly: `, whole(digits, true), "."])
        : answer([`${label}'s number is `, all, "."])
    case "last":
    case "first": {
      const n = Math.min(request.n ?? groups(digits).at(-1)!.length, digits.length)
      if (n >= digits.length) return answer([`The whole number is `, all, "."])
      const part = request.kind === "last" ? digits.slice(-n) : digits.slice(0, n)
      return answer([
        n === 1
          ? `The ${request.kind} digit is `
          : `The ${request.kind} ${COUNT[n] ?? n} digits are `,
        { digits: part },
        ".",
      ])
    }
    case "after":
    case "before": {
      const x = request.digits
      const at = digits.indexOf(x)
      if (at < 0)
        return answer([
          `The number doesn't have `,
          { digits: x },
          ` in it. It's `,
          all,
          ".",
        ])
      if (digits.indexOf(x, at + 1) >= 0)
        return answer([
          { digits: x },
          ` comes more than once. The whole number is `,
          all,
          ".",
        ])
      if (request.kind === "after") {
        const rest = digits.slice(at + x.length)
        return rest
          ? answer([`After `, { digits: x }, ` comes `, { digits: rest }, "."])
          : answer([{ digits: x }, ` is the end of the number.`])
      }
      const before = digits.slice(0, at)
      return before
        ? answer([`Before `, { digits: x }, ` comes `, { digits: before }, "."])
        : answer([`The number starts with `, { digits: x }, "."])
    }
    case "check":
      return check(digits, nationalDigits(request.digits), all, unsure)
  }
}

// The callee read the number (or part of it) back
function check(digits: string, said: string, all: Part, unsure: boolean): NumberAnswer {
  if (said === digits) return answer(["Yes, that's correct."], "correct")
  if (digits.startsWith(said))
    return answer([
      `Yes, that's right so far. Then `,
      { digits: digits.slice(said.length) },
      ".",
    ])
  if (digits.endsWith(said))
    return answer([`Yes, the number ends with `, { digits: said }, "."])
  if (digits.includes(said)) return answer(["Yes, that part is right."])
  // Speech recognition wasn't sure: never tell them they're wrong on a guess
  if (unsure)
    return answer([`Sorry, I didn't catch that clearly. The number is `, all, "."])
  let i = 0
  while (i < said.length && said[i] === digits[i]) i++
  const where: Part[] =
    i >= digits.length
      ? [`, there are too many digits`]
      : i === 0
        ? [`, it starts with `, { digits: digits[0] }, `, not `, { digits: said[0] }]
        : [
            `, after `,
            { digits: digits.slice(0, i) },
            ` it's `,
            { digits: digits[i] },
            `, not `,
            { digits: said[i] },
          ]
  return answer([`Not quite`, ...where, `. The number is `, all, "."], "wrong")
}
