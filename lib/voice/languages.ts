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

const LANGUAGE_NAMES =
  "english|hindi|telugu|tamil|kannada|marathi|bengali|bangla|gujarati|malayalam|punjabi|urdu"
// "Hindi mein baat kariye", "Can you speak Telugu?", "Telugu lo matladandi"
const LANGUAGE_ASKED = new RegExp(
  `\\b(?:speak|talk|in|mein|me|main|lo|lone|please|bolo|boliye|baat|maatladandi|matladandi|matladu|cheppandi)\\b[^.?!]{0,20}\\b(${LANGUAGE_NAMES})\\b|\\b(${LANGUAGE_NAMES})\\b[^.?!]{0,20}\\b(?:speak|talk|mein|me|main|lo|lone|please|bolo|boliye|baat|kariye|maatladandi|matladandi|matladu|cheppandi)\\b|^\\W*(${LANGUAGE_NAMES})\\W*$`
)

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
    // A language asked for that isn't switched on (voice.languages, D-21);
    // the request reaches the owner
    cantSwitch: (owner: string) =>
      `Sorry, I can only speak English on this call for now. I'll let ${owner} know you'd prefer another language.`,
  },

  // "Hindi mein boliye" → "Hindi", or null
  languageAsked(text: string) {
    const t = text.toLowerCase()
    const m = LANGUAGE_ASKED.exec(t)
    const name =
      m?.slice(1).find(Boolean) ??
      (/हिंदी|हिन्दी/.test(t)
        ? "hindi"
        : /తెలుగు/.test(t)
          ? "telugu"
          : /अंग्रेज़ी|अंग्रेजी|ఇంగ్లీష్/.test(t)
            ? "english"
            : null)
    return name ? name[0].toUpperCase() + name.slice(1) : null
  },

  // Tavi's wording where it differs from the policy bundle's (English is
  // the bundle's own); the model's language instruction, null for English
  wording: {} as Partial<Record<string, string>>,
  instruction: null as string | null,
  // "on Wednesday the 21st at 3 PM", " at the office"
  at: (date: string, time: string): string => `on ${en.speak(date, time)}`,
  placeAt: (place: string) => ` at ${place}`,

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
      voicemail: (label: string) =>
        `I reached ${label}'s voicemail and didn't leave a message. I'll try again if there's time.`,
      notReached: (
        label: string,
        at: string[],
        last: "busy" | "no_answer" | "voicemail" | "failed"
      ) =>
        `I haven't been able to reach ${label} yet. I tried ${
          at.length === 1 ? "once" : at.length === 2 ? "twice" : `${at.length} times`
        }, at ${at.length > 1 ? `${at.slice(0, -1).join(", ")} and ${at.at(-1)}` : at[0]}; ${
          last === "busy"
            ? "the line was busy"
            : last === "no_answer"
              ? "there was no answer"
              : last === "voicemail"
                ? "it went to voicemail"
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
      /\b(don'?t|do not|never) (ever )?call (me|this number|here)( again| anymore| any more)?\b|\bstop calling\b|\bremove (my|this) number\b|\b(mujhe|is number par|yahan|dobara|phir se|kabhi) (dobara |phir se |kabhi )?(call|phone) (mat|na) (karo|karna|kariye|kijiye|karein)\b|\b(malli|inka|inkepudu) (call|phone) (cheyakandi|cheyyakandi|cheyodhu|cheyyodu|cheyyakandi)\b|दोबारा (कॉल|फोन) मत|మళ్ళీ కాల్ చేయకండి/
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
    wrongPerson: has(
      /\b(wrong|rong|galat|tappu) (number|nambar|person|vyakti)\b|\byou have the wrong\b|गलत नंबर|రాంగ్ నంబర్|తప్పు నంబర్/
    ),
    // A voicemail greeting or a network announcement, in English, Hindi or
    // Telugu (S29). Only phrases a person on the line wouldn't say
    voicemail: has(
      /\bleave (a|your) message\b|\bafter the (tone|beep)\b|\bvoice ?mail\b|\bmailbox\b|\bthe number you (have )?(dialled|dialed|are calling|are trying)\b|\b(is|are) (currently )?switched off\b|\bnot reachable\b|\bout of (network )?coverage\b|\bdial kiya gaya\b|\bjis number (par|pe) aap\b|\buplabdh nahi\b|\bsampark (kshetra|kshetr) se bahar\b|\bmeeru dial chesina\b|\bandubatulo ledu\b|\bswitch off cheyabadi\b|\bparidhi velupala\b|डायल किया गया|उपलब्ध नहीं|संपर्क क्षेत्र से बाहर|మీరు డయల్ చేసిన|అందుబాటులో లేదు|పరిధి వెలుపల/
    ),
  },

  // Before a callee's words are stored or shown to a model (SECURITY §7)
  redact: (text: string) =>
    text.replace(SPELLED_RUN, WITHHELD).replace(DIGIT_RUN, WITHHELD),
}

export type Language = Omit<typeof en, "code"> & { code: LanguageCode }
export type LanguageCode = "en-IN" | "hi-IN" | "te-IN"

/* ───────────────────── Hindi and Telugu (voice D-21) ─────────────────────
 * Draft translations, pending a native speaker's and counsel's review of
 * the disclosure (Q4); used only for languages switched on in
 * voice.languages (default English only). Times and dates said in Hindi or
 * Telugu are rewritten into English words and read by the English
 * normaliser, so there is one parser. Digits of a number Tavi gives stay
 * English words (lib/voice/dictation.ts), as phone numbers are commonly
 * said in India. The owner's own calls stay in English.
 * ──────────────────────────────────────────────────────────────────────── */

const nativeDigits = (text: string) =>
  text.replace(/[०-९౦-౯]/g, (c) =>
    String(c.charCodeAt(0) - (c.charCodeAt(0) >= 0x0c66 ? 0x0c66 : 0x0966))
  )
const either =
  (...tests: ((text: string) => boolean)[]) =>
  (text: string) =>
    tests.some((t) => t(text))
// Word boundaries that also hold for Devanagari and Telugu script
const word = (alternatives: string, flags = "iu") =>
  new RegExp(`(?<![\\p{L}\\p{M}])(?:${alternatives})(?![\\p{L}\\p{M}])`, flags)

type Spoken = {
  hours: Record<string, number>
  parts: { am: string; pm: string }
  // The "o'clock" word said after the hour
  oclock: string
  days: [string, string][]
  half?: string
  quarterPast?: string
  quarterTo?: string
  // "3 se 5": a range
  between?: string
}

// "kal shaam 4 baje" → "tomorrow 4 pm"; "repu madhyahnam moodu gantalaku"
// → "tomorrow 3 pm"
function toEnglish(text: string, s: Spoken) {
  const hour = (w: string) => (/^\d{1,2}$/.test(w) ? Number(w) : s.hours[w.toLowerCase()])
  const H = `\\d{1,2}|${Object.keys(s.hours).join("|")}`
  let t = nativeDigits(text.toLowerCase())
  for (const [from, to] of s.days) t = t.replace(word(from, "giu"), to)
  const fraction = (said: string | undefined, to: (h: number) => string) => {
    if (said)
      t = t.replace(word(`(?:${said})\\s+(${H})`, "giu"), (_, h: string) => to(hour(h)))
  }
  fraction(s.half, (h) => `${h}:30`)
  fraction(s.quarterPast, (h) => `${h}:15`)
  fraction(s.quarterTo, (h) => `${(h + 11) % 12 || 12}:45`)
  // The part of the day before or after the hour: "shaam (ko) 4 (baje)"
  for (const [part, m] of [
    [s.parts.am, "am"],
    [s.parts.pm, "pm"],
  ] as const) {
    t = t.replace(
      word(`(?:${part})(?:\\s+ko)?\\s+(${H})(:\\d{2})?(?:\\s+(?:${s.oclock}))?`, "giu"),
      (_, h: string, mm = "") => `${hour(h)}${mm} ${m}`
    )
    t = t.replace(
      word(`(${H})(:\\d{2})?\\s+(?:${s.oclock})\\s+(?:${part})`, "giu"),
      (_, h: string, mm = "") => `${hour(h)}${mm} ${m}`
    )
  }
  t = t.replace(
    word(`(${H})(:\\d{2})?\\s+(?:${s.oclock})`, "giu"),
    (_, h: string, mm = "") => `${hour(h)}${mm} o'clock`
  )
  if (s.between) {
    t = t.replace(
      new RegExp(
        `(\\d{1,2}(?::\\d{2})?)\\s*(?:${s.between})\\s*(\\d{1,2}(?::\\d{2})?)`,
        "giu"
      ),
      "between $1 and $2"
    )
  }
  return t
}

const HI_SPOKEN: Spoken = {
  hours: {
    ek: 1,
    do: 2,
    teen: 3,
    chaar: 4,
    char: 4,
    paanch: 5,
    panch: 5,
    chhah: 6,
    chhe: 6,
    saat: 7,
    aath: 8,
    nau: 9,
    das: 10,
    gyarah: 11,
    gyaarah: 11,
    barah: 12,
    baarah: 12,
    एक: 1,
    दो: 2,
    तीन: 3,
    चार: 4,
    पांच: 5,
    पाँच: 5,
    छह: 6,
    सात: 7,
    आठ: 8,
    नौ: 9,
    दस: 10,
    ग्यारह: 11,
    बारह: 12,
  },
  parts: {
    am: "subah|सुबह",
    pm: "dopahar|dopehar|dupahar|shaam|sham|raat|दोपहर|शाम|रात",
  },
  oclock: "baje|बजे",
  days: [
    ["parson|परसों", "day after tomorrow"],
    ["kal|कल", "tomorrow"],
    ["aaj|आज", "today"],
    ["somvar|somwar|सोमवार", "monday"],
    ["mangalvar|mangalwar|मंगलवार", "tuesday"],
    ["budhvar|budhwar|बुधवार", "wednesday"],
    ["guruvar|guruwar|brihaspativar|गुरुवार|बृहस्पतिवार", "thursday"],
    ["shukravar|shukrawar|शुक्रवार", "friday"],
    ["shanivar|shaniwar|शनिवार", "saturday"],
    ["ravivar|raviwar|itvaar|इतवार|रविवार", "sunday"],
  ],
  half: "saade|sadhe|साढ़े|साढे",
  quarterPast: "sawa|सवा",
  quarterTo: "paune|पौने",
  between: "se|से",
}

const TE_SPOKEN: Spoken = {
  hours: {
    okati: 1,
    rendu: 2,
    moodu: 3,
    mudu: 3,
    naalugu: 4,
    nalugu: 4,
    aidu: 5,
    aaru: 6,
    edu: 7,
    enimidi: 8,
    tommidi: 9,
    padi: 10,
    padakondu: 11,
    pannendu: 12,
    ఒకటి: 1,
    ఒంటి: 1,
    రెండు: 2,
    మూడు: 3,
    నాలుగు: 4,
    ఐదు: 5,
    ఆరు: 6,
    ఏడు: 7,
    ఎనిమిది: 8,
    తొమ్మిది: 9,
    పది: 10,
    పదకొండు: 11,
    పన్నెండు: 12,
  },
  parts: {
    am: "udayam|podduna|ఉదయం|పొద్దున",
    pm: "madhyahnam|madhyaahnam|maddhyanam|saayantram|sayantram|raatri|మధ్యాహ్నం|సాయంత్రం|రాత్రి",
  },
  oclock: "gantalaku|gantaku|gantala ki|ganta|గంటలకు|గంటకు|గంటల",
  days: [
    ["ellundi|ఎల్లుండి", "day after tomorrow"],
    ["repu|రేపు", "tomorrow"],
    ["ivala|ivvala|eeroju|ఈరోజు|ఇవాళ", "today"],
    ["somavaram|సోమవారం", "monday"],
    ["mangalavaram|మంగళవారం", "tuesday"],
    ["budhavaram|బుధవారం", "wednesday"],
    ["guruvaram|గురువారం", "thursday"],
    ["sukravaram|shukravaram|శుక్రవారం", "friday"],
    ["sanivaram|shanivaram|శనివారం", "saturday"],
    ["aadivaram|adivaram|ఆదివారం", "sunday"],
  ],
  between: "nundi|నుండి",
}

// No local hedge or no; then the local yes words read as "yes" and the
// English guard decides, so English hedges and negations still count
// (Hinglish mixes them)
const affirmativeIn = (yes: string, hedge: string, no: string) => (text: string) => {
  const t = text.toLowerCase()
  if (word(hedge).test(t) || word(no).test(t)) return false
  return en.is.affirmative(t.replace(word(yes, "giu"), " yes "))
}

const HI_DAY = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"]
const TE_DAY = [
  "ఆదివారం",
  "సోమవారం",
  "మంగళవారం",
  "బుధవారం",
  "గురువారం",
  "శుక్రవారం",
  "శనివారం",
]
const partOfDay = (h: number, parts: string[]) =>
  h < 12 ? parts[0] : h < 16 ? parts[1] : h < 20 ? parts[2] : parts[3]
const clockIn = (parts: string[], after: string) => (time: string) => {
  const [h, m] = time.split(":").map(Number)
  return `${partOfDay(h, parts)} ${h % 12 || 12}${m ? `:${pad(m)}` : ""} ${after}`
}
const hiClock = clockIn(["सुबह", "दोपहर", "शाम", "रात"], "बजे")
const teClock = clockIn(["ఉదయం", "మధ్యాహ్నం", "సాయంత్రం", "రాత్రి"], "గంటలకు")
const dayOf = (date: string) => new Date(`${date}T00:00:00Z`)
// "बुधवार 21 तारीख को दोपहर 3 बजे"
const hiSpeak = (date: string, time: string) =>
  `${HI_DAY[dayOf(date).getUTCDay()]} ${dayOf(date).getUTCDate()} तारीख को ${hiClock(time)}`
// "బుధవారం, 21వ తేదీ మధ్యాహ్నం 3 గంటలకు"
const teSpeak = (date: string, time: string) =>
  `${TE_DAY[dayOf(date).getUTCDay()]}, ${dayOf(date).getUTCDate()}వ తేదీ ${teClock(time)}`

const hi: Language = {
  ...en,
  code: "hi-IN",
  disclosure: (owner: string) =>
    `नमस्ते, यह Kriya Tavi है — ${owner} की ओर से एक AI सहायक की कॉल। क्या अभी एक छोटे से सवाल के लिए सही समय है?`,
  fixed: {
    isAi: (owner: string) =>
      `जी हाँ, यह एक AI सहायक है। यह कॉल रिकॉर्ड नहीं हो रही; ${owner} को लिखित सारांश मिलेगा।`,
    optOut: "समझ गए, आपको दोबारा कॉल नहीं किया जाएगा। नमस्ते।",
    emergency:
      "यह एक AI सहायक है और आपात स्थिति में मदद नहीं कर सकता। कृपया 112 पर आपातकालीन सेवाओं से संपर्क करें। नमस्ते।",
    cantSwitch: (owner: string) =>
      `माफ़ कीजिए, इस कॉल पर अभी वह भाषा उपलब्ध नहीं है। ${owner} को बता दिया जाएगा कि आप वह भाषा पसंद करेंगे।`,
  },
  wording: {
    confirmPerson: "क्या मेरी बात {owner} के {recipient} से हो रही है?",
    meeting: "{owner} आपसे {when}{place} मिलना चाहते हैं। क्या यह आपके लिए ठीक रहेगा?",
    message: "{owner} ने एक संदेश भेजा है: {message}",
    askReply: "क्या आप कोई जवाब भेजना चाहेंगे?",
    question: "{owner} जानना चाहते हैं: {question}",
    readBack: "तो {when}, ठीक है?",
    checkWithOwner: "{owner} से पूछकर आपको बताया जाएगा।",
    cantShareContact:
      "{owner} की संपर्क जानकारी यहाँ नहीं दी जा सकती। उन्हें बता दिया जाएगा कि आपने पूछा।",
    cantSensitive:
      "इस कॉल पर इसमें मदद नहीं हो सकती। {owner} को बता दिया जाएगा कि आपने पूछा।",
    cantCommit:
      "{owner} की ओर से इस पर हामी नहीं भरी जा सकती; यह बात उन तक पहुँचा दी जाएगी।",
    repeat: "माफ़ कीजिए, क्या आप फिर से बोल सकते हैं?",
    callback: "ज़रूर, {owner} को बता दिया जाएगा।",
    wrongPerson: "माफ़ कीजिए, परेशानी के लिए क्षमा।",
    agreed: "धन्यवाद, {owner} को बता दिया जाएगा।",
    closing: "आपके समय के लिए धन्यवाद। {owner} को जानकारी दे दी जाएगी। नमस्ते।",
    handOff: "{owner} आपसे खुद संपर्क करेंगे। धन्यवाद, नमस्ते।",
  },
  instruction:
    "The callee is speaking Hindi: reply in simple spoken Hindi in Devanagari script; everyday English words are fine. Don't use a gendered verb form for yourself.",
  normalize: (text: string, today: string) =>
    en.normalize(toEnglish(text, HI_SPOKEN), today),
  speak: hiSpeak,
  clock: hiClock,
  at: hiSpeak,
  placeAt: (place: string) => `, ${place} पर,`,
  is: {
    ...en.is,
    affirmative: affirmativeIn(
      "haan|haa|ha|ji|jee|theek hai|thik hai|bilkul|chalega|zaroor|jaroor|sahi hai|हाँ|हां|जी|ठीक है|बिल्कुल|चलेगा|ज़रूर|जरूर|सही है",
      "shayad|dekhta|dekhti|dekhenge|dekh ke|dekhkar|bata dunga|bata dungi|sochke|soch ke|pata nahi|शायद|देखता|देखती|देखेंगे|बता दूँगा|बता दूंगी|पता नहीं|सोचके|सोच के",
      "nahi|nahin|mat|na|नहीं|मत|ना"
    ),
    emergency: either(
      en.is.emergency,
      has(word("aapatkal|durghatna|एम्बुलेंस|दुर्घटना|आपातकाल|अस्पताल में"))
    ),
    askingIfAi: either(
      en.is.askingIfAi,
      has(
        word(
          "(?:kya )?(?:aap|ye|yeh) (?:robot|machine|computer|ai) (?:hai|hain|ho)|रोबोट|मशीन"
        )
      )
    ),
    contactRequest: either(
      en.is.contactRequest,
      has(
        word(
          "(?:unka|unki|unke|uska|uski)[^.?!]{0,20}(?:number|phone|mobile|address|pata|email)|उनका नंबर|उनका पता"
        )
      )
    ),
  },
}

const te: Language = {
  ...en,
  code: "te-IN",
  disclosure: (owner: string) =>
    `నమస్కారం, ఇది Kriya Tavi — ${owner} గారి తరఫున ఒక AI అసిస్టెంట్ చేస్తున్న కాల్. ఒక చిన్న ప్రశ్నకు ఇది సరైన సమయమేనా?`,
  fixed: {
    isAi: (owner: string) =>
      `అవును, నేను ఒక AI అసిస్టెంట్‌ని. ఈ కాల్ రికార్డ్ చేయడం లేదు; ${owner} గారికి రాతపూర్వక సారాంశం అందుతుంది.`,
    optOut: "సరే, మీకు మళ్ళీ కాల్ చేయము. నమస్కారం.",
    emergency:
      "నేను AI అసిస్టెంట్‌ని, అత్యవసర పరిస్థితిలో సహాయం చేయలేను. దయచేసి 112 కి కాల్ చేయండి. నమస్కారం.",
    cantSwitch: (owner: string) =>
      `క్షమించండి, ఈ కాల్‌లో ఆ భాష ఇప్పుడు అందుబాటులో లేదు. మీరు ఆ భాష కోరుకున్నారని ${owner} గారికి చెబుతాను.`,
  },
  wording: {
    confirmPerson: "నేను {owner} గారి {recipient} తో మాట్లాడుతున్నానా?",
    meeting: "{owner} గారు మిమ్మల్ని {when}{place} కలవాలనుకుంటున్నారు. మీకు వీలవుతుందా?",
    message: "{owner} గారు ఒక సందేశం పంపారు: {message}",
    askReply: "మీరు ఏదైనా సమాధానం చెప్పాలనుకుంటున్నారా?",
    question: "{owner} గారు తెలుసుకోవాలనుకుంటున్నారు: {question}",
    readBack: "అంటే {when}, సరేనా?",
    checkWithOwner: "{owner} గారిని అడిగి మీకు తెలియజేస్తాను.",
    cantShareContact:
      "{owner} గారి కాంటాక్ట్ వివరాలు నేను ఇవ్వలేను. మీరు అడిగారని వారికి చెబుతాను.",
    cantSensitive:
      "ఈ కాల్‌లో దానికి సహాయం చేయలేను. మీరు అడిగారని {owner} గారికి చెబుతాను.",
    cantCommit: "{owner} గారి తరఫున దానికి ఒప్పుకోలేను; వారికి తెలియజేస్తాను.",
    repeat: "క్షమించండి, మళ్ళీ చెప్పగలరా?",
    callback: "తప్పకుండా, {owner} గారికి చెబుతాను.",
    wrongPerson: "క్షమించండి, ఇబ్బంది పెట్టినందుకు.",
    agreed: "ధన్యవాదాలు, {owner} గారికి చెబుతాను.",
    closing: "మీ సమయానికి ధన్యవాదాలు. {owner} గారికి తెలియజేస్తాను. నమస్కారం.",
    handOff: "{owner} గారు మిమ్మల్ని సంప్రదిస్తారు. ధన్యవాదాలు, నమస్కారం.",
  },
  instruction:
    "The callee is speaking Telugu: reply in simple spoken Telugu in Telugu script; everyday English words are fine.",
  normalize: (text: string, today: string) =>
    en.normalize(toEnglish(text, TE_SPOKEN), today),
  speak: teSpeak,
  clock: teClock,
  at: teSpeak,
  placeAt: (place: string) => `, ${place} లో,`,
  is: {
    ...en.is,
    affirmative: affirmativeIn(
      "avunu|aunu|sare|sari|alage|kudurutundi|kuduruthundi|tappakunda|అవును|సరే|అలాగే|కుదురుతుంది|తప్పకుండా",
      "emo|chustanu|chusta|cheptanu|chepta|telidu|aalochistanu|ఏమో|చూస్తాను|చెబుతాను|తెలియదు|ఆలోచిస్తాను",
      "ledu|kaadu|vaddu|kudaradu|kuradu|లేదు|కాదు|వద్దు|కుదరదు"
    ),
    emergency: either(
      en.is.emergency,
      has(word("pramaadam|aaspatri|ప్రమాదం|అంబులెన్స్|ఆసుపత్రి"))
    ),
    askingIfAi: either(
      en.is.askingIfAi,
      has(word("(?:meeru|idi) (?:robot|machine|ai|computer)|రోబో|యంత్రం"))
    ),
    contactRequest: either(
      en.is.contactRequest,
      has(
        word(
          "(?:aayana|aame|vaari|valla)[^.?!]{0,20}(?:number|phone|address|email)|ఆయన నంబర్|ఆమె నంబర్"
        )
      )
    ),
  },
}

export const LANGUAGES: Record<LanguageCode, Language> = {
  "en-IN": en,
  "hi-IN": hi,
  "te-IN": te,
}

// "Hindi" (from languageAsked) → its code, where Kriya has the language
export const LANGUAGE_CODES: Record<string, LanguageCode> = {
  English: "en-IN",
  Hindi: "hi-IN",
  Telugu: "te-IN",
}

export const languageFor = (code: string): Language =>
  LANGUAGES[code as LanguageCode] ?? LANGUAGES["en-IN"]
