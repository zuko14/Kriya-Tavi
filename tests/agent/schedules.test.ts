import { describe, expect, it } from "vitest"

import {
  describeRule,
  minGapMinutes,
  nextRun,
  nextRuns,
  ruleSchema,
  runsPerMonth,
} from "@/lib/schedules"

// AT-SCH-01: next-run maths for every rule kind, in Asia/Kolkata (UTC+5:30,
// no daylight saving), across day, month and year ends.

// An IST wall-clock time as a Date
const ist = (s: string) => new Date(`${s}+05:30`)
const iso = (d: Date | null) => d?.toISOString() ?? null

describe("rule validation", () => {
  it("accepts each kind and refuses the rest", () => {
    expect(ruleSchema.safeParse({ freq: "daily", at: "09:00" }).success).toBe(true)
    expect(
      ruleSchema.safeParse({ freq: "weekly", at: "18:30", days: [1, 5] }).success
    ).toBe(true)
    expect(
      ruleSchema.safeParse({ freq: "monthly", at: "07:05", dayOfMonth: 28 }).success
    ).toBe(true)
    expect(ruleSchema.safeParse({ freq: "interval", everyMinutes: 60 }).success).toBe(
      true
    )
    expect(
      ruleSchema.safeParse({ freq: "once", startAt: "2026-10-20T10:00:00+05:30" }).success
    ).toBe(true)

    for (const bad of [
      { freq: "daily", at: "24:00" },
      { freq: "daily", at: "9:00" },
      { freq: "weekly", at: "09:00", days: [] },
      { freq: "weekly", at: "09:00", days: [0] },
      { freq: "monthly", at: "09:00", dayOfMonth: 29 },
      { freq: "interval", everyMinutes: 59 },
      { freq: "once" },
      { freq: "hourly" },
    ]) {
      expect(ruleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe("next run in IST (AT-SCH-01)", () => {
  it("daily: later today, else tomorrow, across the month and year end", () => {
    const rule = { freq: "daily", at: "09:00" } as const
    expect(iso(nextRun(rule, ist("2026-10-18T08:59:00")))).toBe(
      iso(ist("2026-10-18T09:00:00"))
    )
    // Exactly at the time: strictly after, so tomorrow
    expect(iso(nextRun(rule, ist("2026-10-18T09:00:00")))).toBe(
      iso(ist("2026-10-19T09:00:00"))
    )
    expect(iso(nextRun(rule, ist("2026-12-31T23:00:00")))).toBe(
      iso(ist("2027-01-01T09:00:00"))
    )
    // 00:30 IST is still the previous day in UTC
    expect(iso(nextRun({ freq: "daily", at: "00:30" }, ist("2026-10-18T23:59:00")))).toBe(
      iso(ist("2026-10-19T00:30:00"))
    )
  })

  it("weekly: the next listed weekday (1 = Monday … 7 = Sunday)", () => {
    // 2026-10-18 is a Sunday
    const rule = { freq: "weekly", at: "09:00", days: [1, 5] } as const
    expect(iso(nextRun(rule, ist("2026-10-18T12:00:00")))).toBe(
      iso(ist("2026-10-19T09:00:00"))
    )
    expect(iso(nextRun(rule, ist("2026-10-19T09:00:00")))).toBe(
      iso(ist("2026-10-23T09:00:00"))
    )
    expect(
      iso(nextRun({ freq: "weekly", at: "20:00", days: [7] }, ist("2026-10-18T19:00:00")))
    ).toBe(iso(ist("2026-10-18T20:00:00")))
  })

  it("monthly: the day of the month, rolling into the next month and year", () => {
    const rule = { freq: "monthly", at: "10:00", dayOfMonth: 28 } as const
    expect(iso(nextRun(rule, ist("2026-10-18T00:00:00")))).toBe(
      iso(ist("2026-10-28T10:00:00"))
    )
    expect(iso(nextRun(rule, ist("2026-10-28T10:00:00")))).toBe(
      iso(ist("2026-11-28T10:00:00"))
    )
    expect(iso(nextRun(rule, ist("2026-12-29T00:00:00")))).toBe(
      iso(ist("2027-01-28T10:00:00"))
    )
    // February has a 28th every year
    expect(iso(nextRun(rule, ist("2027-01-29T00:00:00")))).toBe(
      iso(ist("2027-02-28T10:00:00"))
    )
  })

  it("interval: every N minutes from the start, never in the past", () => {
    const rule = {
      freq: "interval",
      everyMinutes: 90,
      startAt: "2026-10-18T09:00:00+05:30",
    } as const
    expect(iso(nextRun(rule, ist("2026-10-18T08:00:00")))).toBe(
      iso(ist("2026-10-18T09:00:00"))
    )
    expect(iso(nextRun(rule, ist("2026-10-18T09:00:00")))).toBe(
      iso(ist("2026-10-18T10:30:00"))
    )
    expect(iso(nextRun(rule, ist("2026-10-18T23:59:00")))).toBe(
      iso(ist("2026-10-19T00:00:00"))
    )
    // Without a start: N minutes after
    expect(
      iso(nextRun({ freq: "interval", everyMinutes: 60 }, ist("2026-10-18T09:15:00")))
    ).toBe(iso(ist("2026-10-18T10:15:00")))
  })

  it("once: its time if still ahead, then never again", () => {
    const rule = { freq: "once", startAt: "2026-10-20T10:00:00+05:30" } as const
    expect(iso(nextRun(rule, ist("2026-10-18T00:00:00")))).toBe(
      iso(ist("2026-10-20T10:00:00"))
    )
    expect(nextRun(rule, ist("2026-10-20T10:00:00"))).toBeNull()
  })

  it("lists the next three runs for the approval card", () => {
    expect(
      nextRuns(
        { freq: "weekly", at: "09:00", days: [1] },
        ist("2026-10-18T00:00:00")
      ).map(iso)
    ).toEqual(
      ["2026-10-19", "2026-10-26", "2026-11-02"].map((d) => iso(ist(`${d}T09:00:00`)))
    )
  })
})

describe("cadence for people and limits", () => {
  it("describes the rule in words, in IST", () => {
    expect(describeRule({ freq: "daily", at: "18:30" })).toBe("Every day at 6:30 pm")
    expect(describeRule({ freq: "weekly", at: "09:00", days: [1] })).toBe(
      "Every Monday at 9:00 am"
    )
    expect(describeRule({ freq: "weekly", at: "12:00", days: [1, 3, 5] })).toBe(
      "Every Monday, Wednesday and Friday at 12:00 pm"
    )
    expect(describeRule({ freq: "monthly", at: "00:15", dayOfMonth: 1 })).toBe(
      "On day 1 of every month at 12:15 am"
    )
    expect(describeRule({ freq: "interval", everyMinutes: 120 })).toBe(
      "Every 120 minutes"
    )
    expect(describeRule({ freq: "once", startAt: "2026-10-20T10:00:00+05:30" })).toBe(
      "Once, on 20 Oct 2026 at 10:00 am"
    )
  })

  it("estimates runs per month and the shortest gap between runs", () => {
    expect(runsPerMonth({ freq: "daily", at: "09:00" })).toBe(30)
    expect(runsPerMonth({ freq: "weekly", at: "09:00", days: [1, 4] })).toBe(9)
    expect(runsPerMonth({ freq: "monthly", at: "09:00", dayOfMonth: 5 })).toBe(1)
    expect(runsPerMonth({ freq: "interval", everyMinutes: 1440 })).toBe(30)
    expect(runsPerMonth({ freq: "once", startAt: "2026-10-20T10:00:00Z" })).toBe(1)

    expect(minGapMinutes({ freq: "daily", at: "09:00" })).toBe(1440)
    expect(minGapMinutes({ freq: "weekly", at: "09:00", days: [7, 1] })).toBe(1440)
    expect(minGapMinutes({ freq: "weekly", at: "09:00", days: [3] })).toBe(10080)
    expect(minGapMinutes({ freq: "monthly", at: "09:00", dayOfMonth: 5 })).toBe(40320)
    expect(minGapMinutes({ freq: "interval", everyMinutes: 90 })).toBe(90)
    expect(minGapMinutes({ freq: "once", startAt: "2026-10-20T10:00:00Z" })).toBe(
      Number.POSITIVE_INFINITY
    )
  })
})
