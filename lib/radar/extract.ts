// Kriya Radar (K4, AD-30): an obligation's date counts only when its quote
// is found word for word in what was read, and the quote itself holds that
// date. Pure: no database, no model. The agent proposes {date, quote,
// source}; code decides `verified`.

export const TIMEZONE = "Asia/Kolkata"

const normalise = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()

export const quoteFound = (quote: string, sources: string[]) =>
  quote.trim().length > 0 &&
  sources.some((source) => normalise(source).includes(normalise(quote)))

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

// The calendar date of an instant in India
export function istDate(at: Date) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE })
    .format(at)
    .split("-")
    .map(Number)
  return { y, m, d }
}

// Whether the quote names this day: 10 October 2026, 10 Oct 2026,
// October 10, 2026, 10/10/2026, 10-10-2026, 10.10.2026, 2026-10-10, with
// or without ordinals and leading zeros. ponytail: English month names only;
// add Hindi and other scripts with real notices to test against.
export function dateInQuote(dueAt: Date, quote: string) {
  const { y, m, d } = istDate(dueAt)
  const text = ` ${normalise(quote)
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")} `
  const month = MONTHS[m - 1]
  const short = month.slice(0, 3)
  const dd = String(d).padStart(2, "0")
  const mm = String(m).padStart(2, "0")
  const days = [String(d), dd]
  const forms = [
    ...days.flatMap((day) => [
      `${day} ${month} ${y}`,
      `${day} ${short} ${y}`,
      `${day}-${short}-${y}`,
      `${month} ${day} ${y}`,
      `${short} ${day} ${y}`,
    ]),
    ...days.flatMap((day) =>
      [mm, String(m)].flatMap((mon) => [
        `${day}/${mon}/${y}`,
        `${day}-${mon}-${y}`,
        `${day}.${mon}.${y}`,
      ])
    ),
    `${y}-${mm}-${dd}`,
  ]
  return forms.some((form) =>
    new RegExp(`(^|[^0-9a-z])${form.replace(/[.]/g, "\\.")}([^0-9a-z]|$)`).test(text)
  )
}

export function checkObligation(
  input: { dueAt: Date; quote: string },
  sources: string[]
): { verified: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!quoteFound(input.quote, sources))
    reasons.push("The quote wasn't found word for word in the source.")
  if (!dateInQuote(input.dueAt, input.quote))
    reasons.push("The quote doesn't contain the due date.")
  return { verified: reasons.length === 0, reasons }
}

// When to remind, at 9:00 India time on each lead day before the due date's
// Indian calendar day (AT-RAD-02). Date.UTC carries month and year ends.
export function reminderTimes(dueAt: Date, leadDays: number[]) {
  const { y, m, d } = istDate(dueAt)
  return [...new Set(leadDays)]
    .sort((a, b) => b - a)
    .map((days) => new Date(Date.UTC(y, m - 1, d - days, 3, 30)))
}

// Until the voice track ships, a reminder is shown in Kriya (Radar, Home)
// and never sent anywhere else (AD-20, voice rule 10; AT-RAD-04)
export type ReminderChannel = "voice_call" | "in_app"
export const reminderChannel = (voiceRemindersLive = false): ReminderChannel =>
  voiceRemindersLive ? "voice_call" : "in_app"

// The lead day the person is in now, if any: "in 7 days", "tomorrow"
export function dueSoon(dueAt: Date, leadDays: number[], now = new Date()) {
  const passed = reminderTimes(dueAt, leadDays).filter((t) => t <= now)
  return passed.length > 0 && now < dueAt
}
