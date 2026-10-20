// When voice calls may start (SECURITY_AND_COMPLIANCE.md §5,
// VOICE_REMINDERS.md §2–3). Third parties: 09:00–21:00 IST, Monday to
// Saturday. The owner: any time outside their quiet hours, in their own
// IANA timezone. Pure functions over instants; callers pass database time.
//
// Not covered: national holidays. The rule says they're off in the MVP,
// but there's no holiday list in the repo and none is invented here; until
// one is added (an owner-maintained list), only Sundays are skipped.

const IST = "Asia/Kolkata"
const CALLING_START = "09:00"
const CALLING_END = "21:00"
// After a busy or unanswered call to a third party
export const OUTREACH_RETRY_MINUTES = 15
const REPORT_WINDOW_MS = 2 * 60 * 60_000
const MINUTE = 60_000

// The app's "now" for voice decisions; tests pin it (TEST_STRATEGY §4).
// Due-ness in the queue is still decided by the database's now()
export const clock = { now: () => new Date() }

type Local = { date: string; time: string; weekday: number }

// Wall-clock date (YYYY-MM-DD), time (HH:mm:ss) and weekday (0 = Sunday)
function local(at: Date, timeZone: string): Local {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  }
}

const asUtc = (date: string, time: string) => Date.parse(`${date}T${time}Z`)
const offsetAt = (instant: number, timeZone: string) => {
  const { date, time } = local(new Date(instant), timeZone)
  return asUtc(date, time) - instant
}

// The instant a wall-clock time happens in a zone (second pass for DST)
export function fromLocal(date: string, time: string, timeZone: string) {
  const wall = asUtc(date, time.length === 5 ? `${time}:00` : time)
  let instant = wall - offsetAt(wall, timeZone)
  instant = wall - offsetAt(instant, timeZone)
  return new Date(instant)
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const hhmm = (time: string) => time.slice(0, 5)

export function withinCallingHours(at: Date) {
  const { time, weekday } = local(at, IST)
  return weekday !== 0 && hhmm(time) >= CALLING_START && hhmm(time) < CALLING_END
}

// `at` itself if a third party may be called then, else the next opening
export function nextCallingTime(at: Date) {
  if (withinCallingHours(at)) return at
  const { date, time } = local(at, IST)
  for (let day = hhmm(time) < CALLING_START ? 0 : 1; day <= 7; day++) {
    const start = fromLocal(addDays(date, day), CALLING_START, IST)
    if (local(start, IST).weekday !== 0) return start
  }
  throw new Error("no calling hours within a week")
}

export const outreachRetryAt = (from: Date) =>
  nextCallingTime(new Date(from.getTime() + OUTREACH_RETRY_MINUTES * MINUTE))

export type QuietHours = { timezone: string; quietStart: string; quietEnd: string }

export function inQuietHours(at: Date, profile: QuietHours) {
  const now = hhmm(local(at, profile.timezone).time)
  const start = hhmm(profile.quietStart)
  const end = hhmm(profile.quietEnd)
  return start <= end ? now >= start && now < end : now >= start || now < end
}

// The next time quiet hours begin after `at`
function nextQuietStart(at: Date, profile: QuietHours) {
  const { date } = local(at, profile.timezone)
  for (let day = 0; day <= 1; day++) {
    const start = fromLocal(
      addDays(date, day),
      hhmm(profile.quietStart),
      profile.timezone
    )
    if (start > at) return start
  }
  return fromLocal(addDays(date, 2), hhmm(profile.quietStart), profile.timezone)
}

// [report_at, min(report_at + 2 h, next quiet-hours start)) (VOICE_REMINDERS §3)
export function reportWindowEnd(reportAt: Date, profile: QuietHours) {
  const twoHours = new Date(reportAt.getTime() + REPORT_WINDOW_MS)
  const quiet = nextQuietStart(reportAt, profile)
  return quiet < twoHours ? quiet : twoHours
}

// The next report attempt, or null when it would fall in quiet hours
export function reportRetryAt(from: Date, profile: QuietHours, gapMinutes: number) {
  const at = new Date(from.getTime() + gapMinutes * MINUTE)
  return inQuietHours(at, profile) ? null : at
}

// Midnight of the day `at` falls on, in a zone (IST for the daily limits)
export const dayStart = (at: Date, timeZone = IST) =>
  fromLocal(local(at, timeZone).date, "00:00", timeZone)

// The next day's first calling time
export const tomorrowOpening = (at: Date) =>
  nextCallingTime(new Date(dayStart(at).getTime() + 86_400_000))

// An outreach call may be retried until the report time, else for a day.
// ponytail: the docs don't fix this window; 24 h is the default chosen here
export const outreachWindowEnd = (notBefore: Date, reportAt: Date | null) =>
  reportAt ?? new Date(notBefore.getTime() + 86_400_000)
