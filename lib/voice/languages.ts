import { disclosure } from "./schemas"

// Everything about a call that depends on its language (D-11,
// VOICE_ARCHITECTURE §10): the fixed lines, how spoken times and dates
// become {date, time}, the lexicons code trusts over the model, and
// redaction. English (en-IN) only for now; Hindi is a new entry here plus
// its evaluation data, never a new code path. Plain functions, no imports
// beyond the disclosure, so kriya-voice can load it (F7).

export type Moment = {
  // YYYY-MM-DD and HH:mm (24 h), in the owner's timezone
  date: string | null
  time: string | null
  // "between 3 and 5"
  window: { from: string; to: string } | null
  // What Tavi has to ask back before recording it (CONVERSATION §4)
  ask: "meridiem" | "time" | null
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]
const UNITS = [
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
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
]
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 }

const pad = (n: number) => String(n).padStart(2, "0")
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// The calendar date at an instant in a timezone ("tomorrow" is relative to it)
export function localDate(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)
}

// "four thirty" → "4 30", "forty five" → "45"
function digitsFor(text: string) {
  return text
    .replace(
      /\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g,
      (_, t: string, u: string) => String(TENS[t] + UNITS.indexOf(u))
    )
    .replace(/\b(twenty|thirty|forty|fifty)\b/g, (t) => String(TENS[t]))
    .replace(new RegExp(`\\b(${UNITS.slice(1).join("|")})\\b`, "g"), (u) =>
      String(UNITS.indexOf(u))
    )
}

// "3 pm", "3pm", "3 p.m.", "in the evening", right after a time
const MERIDIEM =
  /^\s*(?:(a\.?m\.?|p\.?m\.?)(?=\W|$)|in the (morning|afternoon|evening|night)\b)/
const meridiemAfter = (text: string, end: number) =>
  MERIDIEM.exec(text.slice(end))?.[0].trim() ?? null

// No AM/PM said: 1–7 is the afternoon, 8–11 the morning (office hours),
// then Tavi asks back. ponytail: a fixed office-hours guess; per-owner
// hours if the read-backs show it's often wrong.
function clock(hour: number, minute: number, said: string | null) {
  if (said === null) {
    if (hour === 0 || hour > 12) return { time: hhmm(hour % 24, minute), sure: true }
    return { time: hhmm(hour <= 7 ? hour + 12 : hour, minute), sure: false }
  }
  const pm = /^p|afternoon|evening|night/.test(said)
  const h = pm ? (hour % 12) + 12 : hour % 12
  return { time: hhmm(h, minute), sure: true }
}

// Every match of a pattern, with where it was said
function* mentions<T>(text: string, pattern: RegExp, read: (m: RegExpExecArray) => T) {
  for (const m of text.matchAll(pattern)) {
    yield { at: m.index, end: m.index + m[0].length, ...read(m) }
  }
}

// The last mention wins: "not 3, can we do 4:30" is 4:30. A mention inside
// a longer one ("3" in "half past 3") isn't a mention of its own
const latest = <T extends { at: number; end: number }>(found: T[]) =>
  found
    .filter(
      (c) =>
        !found.some(
          (d) => d !== c && d.at <= c.at && d.end >= c.end && d.end - d.at > c.end - c.at
        )
    )
    .reduce<T | null>((a, b) => (!a || b.at >= a.at ? b : a), null)

function parseTime(text: string): Pick<Moment, "time" | "window" | "ask"> {
  const range =
    /\b(?:between|from) (\d{1,2})(?::(\d{2}))? (?:and|to|till|-) (\d{1,2})(?::(\d{2}))?\b/.exec(
      text
    )
  if (range) {
    const said = meridiemAfter(text, range.index + range[0].length)
    const from = clock(+range[1], +(range[2] ?? 0), said)
    const to = clock(+range[3], +(range[4] ?? 0), said)
    return { time: null, window: { from: from.time, to: to.time }, ask: "time" }
  }

  const at = (hour: number, minute = 0, exact = false) => ({ hour, minute, exact })
  const found = [
    // "09:00" is a 24-hour time as said
    ...mentions(text, /\b(\d{1,2})[:.](\d{2})\b/g, (m) =>
      at(+m[1], +m[2], m[1].length === 2 && m[1].startsWith("0"))
    ),
    ...mentions(text, /\bhalf past (\d{1,2})\b/g, (m) => at(+m[1], 30)),
    ...mentions(text, /\bquarter past (\d{1,2})\b/g, (m) => at(+m[1], 15)),
    ...mentions(text, /\bquarter to (\d{1,2})\b/g, (m) =>
      at((+m[1] + 11) % 12 || 12, 45)
    ),
    // Spoken "four thirty"
    ...mentions(text, /\b(\d{1,2}) (\d{2})\b/g, (m) => at(+m[1], +m[2])),
    ...mentions(
      text,
      /\b(\d{1,2})(?=\s*(?:a\.?m\b|p\.?m\b|o'?clock\b|in the (?:morning|afternoon|evening)))/g,
      (m) => at(+m[1])
    ),
    ...mentions(
      text,
      /\b(?:at|by|around|after|before) (\d{1,2})\b(?![:.]\d|\s\d{2}\b)/g,
      (m) => at(+m[1])
    ),
    ...mentions(text, /^\W*(\d{1,2})\W*$/g, (m) => at(+m[1])),
    ...mentions(text, /\b(noon|midday)\b/g, () => at(12, 0, true)),
  ].filter((c) => c.hour <= 23 && c.minute <= 59)
  const last = latest(found)
  if (!last) {
    const part = /\b(morning|afternoon|evening)\b/.test(text)
    return { time: null, window: null, ask: part ? "time" : null }
  }
  const told = last.exact
    ? { time: hhmm(last.hour, last.minute), sure: true }
    : clock(last.hour, last.minute, meridiemAfter(text, last.end))
  return { time: told.time, window: null, ask: told.sure ? null : "meridiem" }
}

function parseDate(text: string, today: string): string | null {
  const months = MONTHS.join("|")
  const onDay = (day: number, month: string | undefined) => {
    const [y, mo, d] = today.split("-").map(Number)
    let year = y
    let monthIndex = month ? MONTHS.indexOf(month) : mo - 1
    if (!month && day < d) monthIndex += 1
    if (month && (monthIndex < mo - 1 || (monthIndex === mo - 1 && day < d))) year += 1
    const date = new Date(Date.UTC(year, monthIndex, day))
    // "the 31st" in a 30-day month
    return date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null
  }
  const weekday = (name: string) => {
    const from = new Date(`${today}T00:00:00Z`).getUTCDay()
    return addDays(today, (WEEKDAYS.indexOf(name) - from + 7) % 7 || 7)
  }
  const found = [
    ...mentions(text, /\bday after tomorrow\b/g, () => ({ date: addDays(today, 2) })),
    ...mentions(text, /(?<!after )\btomorrow\b/g, () => ({ date: addDays(today, 1) })),
    ...mentions(text, /\btoday\b/g, () => ({ date: today })),
    ...mentions(text, new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`, "g"), (m) => ({
      date: weekday(m[1]),
    })),
    ...mentions(
      text,
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)\\b(?: (?:of )?(${months}))?`, "g"),
      (m) => ({ date: onDay(+m[1], m[2]) })
    ),
    ...mentions(
      text,
      new RegExp(`\\b(${months}) (\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"),
      (m) => ({
        date: onDay(+m[2], m[1]),
      })
    ),
  ]
  return latest(found)?.date ?? null
}

const ORDINAL = (n: number) =>
  n % 10 === 1 && n !== 11
    ? "st"
    : n % 10 === 2 && n !== 12
      ? "nd"
      : n % 10 === 3 && n !== 13
        ? "rd"
        : "th"

const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)"
const SPELLED_RUN = new RegExp(`\\b${DIGIT_WORD}(?:[\\s,-]+${DIGIT_WORD}){3,}\\b`, "gi")
// Four or more digits, with spaces or dashes between them: OTPs, PINs,
// cards, phone numbers. "4:30" and "the 18th" stay. ponytail: a spoken
// year ("2026") is withheld too; dates reach the outcome through the notes
const DIGIT_RUN = /\d(?:[\s-]?\d){3,}/g
const WITHHELD = "[number withheld]"

const has = (pattern: RegExp) => (text: string) => pattern.test(text.toLowerCase())

const en = {
  code: "en-IN" as const,
  // Fixed lines (CONVERSATION §3, §8); not tunable by the policy bundle
  disclosure,
  fixed: {
    isAi: (owner: string) =>
      `Yes, I'm an AI assistant. This call isn't recorded; ${owner} will get a written summary.`,
    optOut: "Understood, I'll make sure you're not called again. Goodbye.",
    emergency:
      "I'm an AI assistant and can't help with an emergency. Please contact emergency services on 112. Goodbye.",
  },

  normalize(text: string, today: string): Moment {
    const lower = digitsFor(text.toLowerCase())
    return { date: parseDate(lower, today), ...parseTime(lower) }
  },

  // "Thursday the 15th at 3:30 PM"
  speak(date: string, time: string) {
    const d = new Date(`${date}T00:00:00Z`)
    const weekday = WEEKDAYS[d.getUTCDay()]
    const day = d.getUTCDate()
    return `${weekday[0].toUpperCase()}${weekday.slice(1)} the ${day}${ORDINAL(day)} at ${en.clock(time)}`
  },

  // "15:30" → "3:30 PM"
  clock(time: string) {
    const [h, m] = time.split(":").map(Number)
    return `${h % 12 || 12}${m ? `:${pad(m)}` : ""} ${h < 12 ? "AM" : "PM"}`
  },

  // The owner's own calls (VOICE_REMINDERS §4, §7; D-13): fixed lines and
  // fixed patterns, no model. ponytail: keyword intents; a phrasing they
  // miss gets "I can't do that on this call", never a guess
  owner: {
    greeting: (label: string, first: string) =>
      `Hi, this is Kriya Tavi with your update about the call to ${label}. Is this ${first}?`,
    askAgain: (first: string) => `Hello? Is this ${first}?`,
    wrongPerson: "Sorry, wrong person. Goodbye.",
    offer: "You can ask me something, or say 'that's all'.",
    goodbye: "Thank you. Goodbye.",
    cantDo: "I can't do that on this call; you can do it in the Kriya app.",
    confirmCancel: (label: string) =>
      `I'll cancel the other report calls about ${label}. Shall I go ahead?`,
    cancelled: "Done, they're cancelled.",
    nothingToCancel: "There are no other report calls to cancel.",
    askWhen: "What time should I call you again?",
    confirmRemind: (when: string) => `I'll call you again on ${when}. Shall I go ahead?`,
    reminded: "Done, I'll call you then.",
    quietHours:
      "That's in your quiet hours, so I can't call you then. Please pick another time.",
    unchanged: "OK, I've left it as it is.",
    draftMade: (label: string) =>
      `I've made a draft of a new call to ${label}. Nobody is called until you confirm it in the Kriya app.`,
    times: (said: string[]) =>
      said.length ? `Times mentioned: ${said.join(", ")}.` : "No times were mentioned.",

    // The report, from the verified outcome at dial time (§5)
    report: {
      agreed: (label: string, when: string) => `${label} agreed to ${when}.`,
      alternative: (label: string, when: string[]) =>
        `${label} couldn't do that, and suggested ${when.join(" or ")}.`,
      declined: (label: string) => `${label} declined.`,
      wrongPerson: "The number reached the wrong person.",
      unclear: (label: string) =>
        `I spoke to ${label}, but the result wasn't clear. The details are in the Kriya app.`,
      review: (label: string) =>
        `I spoke to ${label}, but I couldn't confirm the result. Please check the Kriya app.`,
      notYet: (label: string) => `I haven't called ${label} yet.`,
      notReached: (label: string, at: string[], last: "busy" | "no_answer" | "failed") =>
        `I haven't been able to reach ${label} yet. I tried ${
          at.length === 1 ? "once" : at.length === 2 ? "twice" : `${at.length} times`
        }, at ${at.length > 1 ? `${at.slice(0, -1).join(", ")} and ${at.at(-1)}` : at[0]}; ${
          last === "busy"
            ? "the line was busy"
            : last === "no_answer"
              ? "there was no answer"
              : "the call didn't go through"
        }.`,
      questions: (asked: string[]) => `They asked: ${asked.join(" ")}`,
    },

    verify: {
      ask: "Hi, this is Kriya Tavi. To verify this number, please key in the 6-digit code shown on your screen.",
      keypad: "Please key in the code on your keypad.",
      done: "Thank you, your number is verified. Goodbye.",
      again: "That code didn't match. Please try again.",
      failed: "That code didn't match. Please start again in the Kriya app. Goodbye.",
    },

    is: {
      no: has(
        /^\s*(no|nope|nahi|nahin)\b|\bwrong (number|person)\b|\bnot (me|him|her)\b/
      ),
      done: has(
        /\b(that'?s all|that is all|nothing else|no,? thanks|bye|goodbye|got it|thanks|thank you|okay|ok)\b/
      ),
      repeat: has(/\b(repeat|say (that|it) again|come again|once more|pardon)\b/),
      times: has(/\b(what|which) time\b|\bsuggest/),
      cancel: has(/\bcancel\b/),
      remind: has(/\bremind me\b|\bcall me (again|back|later|at|tomorrow|tonight)\b/),
      callAgain: has(/\b(call|try) (him|her|them)\b.*\bagain\b|\bcall .* again\b/),
    },
  },

  is: {
    // Code's half of the agreement guard: an affirmative with no hedge and
    // no negation (CONVERSATION §1: "should be fine" is not agreement)
    affirmative: (text: string) => {
      const t = text.toLowerCase()
      if (
        /\b(maybe|perhaps|probably|possibly|might|should be|i think|i guess|not sure|let me (check|see|confirm)|i'?ll (check|see|confirm|let you know)|try)\b/.test(
          t
        )
      )
        return false
      if (
        /\b(no|nope|not|don'?t|can'?t|cannot|won'?t|isn'?t|doesn'?t|nahi|nahin)\b/.test(t)
      )
        return false
      return /\b(yes|yeah|yep|yup|sure|correct|right|fine|okay|ok|haan|ji|confirmed|done|perfect|great|absolutely|definitely|works|sounds good|agreed)\b/.test(
        t
      )
    },
    optOut: has(
      /\b(don'?t|do not|never) (ever )?call (me|this number|here)( again| anymore| any more)?\b|\bstop calling\b|\bremove (my|this) number\b/
    ),
    emergency: has(/\b(emergency|ambulance|accident|bleeding|hospitali[sz]ed)\b/),
    askingIfAi: has(
      /\b(are you|is this|am i (talking|speaking) (to|with)) (a |an )?(bot|robot|machine|computer|ai|real person|human)\b|\brecord(ed|ing)\b/
    ),
    sensitive: has(
      /\b(otp|one[- ]time password|pin|password|cvv|card (number|details)|bank (details|account)|account number|ifsc|upi|aadhaar|pan (card|number))\b|\b(pay|transfer|send) (me )?(money|rs|rupees)\b/
    ),
    contactRequest: has(
      /\b(his|her|their|your (boss|client)'?s?)\b[^.?!]{0,20}\b(number|phone|mobile|address|email|e-mail)\b/
    ),
    injection: has(
      /\b(ignore|disregard|forget) (all |your |the |any |previous |prior )*(instructions|rules|prompt)\b|\byou are now\b|\bsystem prompt\b|\bnew instructions\b/
    ),
    wrongPerson: has(/\bwrong (number|person)\b|\byou have the wrong\b/),
  },

  // Before a callee's words are stored or shown to a model (SECURITY §7)
  redact: (text: string) =>
    text.replace(SPELLED_RUN, WITHHELD).replace(DIGIT_RUN, WITHHELD),
}

export type Language = typeof en

export const LANGUAGES: Record<"en-IN", Language> = { "en-IN": en }

export const languageFor = (code: string) =>
  LANGUAGES[code as keyof typeof LANGUAGES] ?? LANGUAGES["en-IN"]
