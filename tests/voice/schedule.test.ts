import { describe, expect, it } from "vitest"

import {
  fromLocal,
  inQuietHours,
  nextCallingTime,
  outreachRetryAt,
  reportRetryAt,
  reportWindowEnd,
  withinCallingHours,
} from "@/lib/voice/schedule"

// IST is UTC+05:30. 2026-10-20 is a Tuesday; 2026-10-25 a Sunday.
const ist = (local: string) => new Date(`${local}+05:30`)

describe("third-party calling hours (09:00–21:00 IST, Mon–Sat)", () => {
  it("knows when a call to a third party may start", () => {
    expect(withinCallingHours(ist("2026-10-20T09:00:00"))).toBe(true)
    expect(withinCallingHours(ist("2026-10-20T20:59:00"))).toBe(true)
    expect(withinCallingHours(ist("2026-10-20T21:00:00"))).toBe(false)
    expect(withinCallingHours(ist("2026-10-20T08:59:59"))).toBe(false)
    expect(withinCallingHours(ist("2026-10-25T12:00:00"))).toBe(false)
  })

  it("moves a time outside them to the next opening", () => {
    const at = ist("2026-10-20T14:00:00")
    expect(nextCallingTime(at)).toEqual(at)
    expect(nextCallingTime(ist("2026-10-20T06:30:00"))).toEqual(
      ist("2026-10-20T09:00:00")
    )
    expect(nextCallingTime(ist("2026-10-20T22:00:00"))).toEqual(
      ist("2026-10-21T09:00:00")
    )
    // Saturday night → Monday morning
    expect(nextCallingTime(ist("2026-10-24T21:30:00"))).toEqual(
      ist("2026-10-26T09:00:00")
    )
  })

  it("retries a third party after at least 15 minutes, inside the hours", () => {
    expect(outreachRetryAt(ist("2026-10-20T14:00:00"))).toEqual(
      ist("2026-10-20T14:15:00")
    )
    expect(outreachRetryAt(ist("2026-10-20T20:50:00"))).toEqual(
      ist("2026-10-21T09:00:00")
    )
  })
})

describe("the owner's quiet hours, in their timezone", () => {
  const profile = { timezone: "Asia/Kolkata", quietStart: "21:30", quietEnd: "08:00" }

  it("converts a local time to an instant in any IANA zone", () => {
    expect(fromLocal("2026-10-20", "18:00", "Asia/Kolkata")).toEqual(
      ist("2026-10-20T18:00:00")
    )
    expect(fromLocal("2026-10-20", "18:00", "Asia/Dubai")).toEqual(
      new Date("2026-10-20T14:00:00Z")
    )
    // London is on BST until 25 Oct 2026, GMT after
    expect(fromLocal("2026-10-20", "09:00", "Europe/London")).toEqual(
      new Date("2026-10-20T08:00:00Z")
    )
    expect(fromLocal("2026-11-02", "09:00", "Europe/London")).toEqual(
      new Date("2026-11-02T09:00:00Z")
    )
  })

  it("quiet hours wrap past midnight", () => {
    expect(inQuietHours(ist("2026-10-20T21:30:00"), profile)).toBe(true)
    expect(inQuietHours(ist("2026-10-20T23:59:00"), profile)).toBe(true)
    expect(inQuietHours(ist("2026-10-21T07:59:00"), profile)).toBe(true)
    expect(inQuietHours(ist("2026-10-21T08:00:00"), profile)).toBe(false)
    expect(inQuietHours(ist("2026-10-20T18:00:00"), profile)).toBe(false)
    const daytime = { ...profile, quietStart: "13:00", quietEnd: "14:00" }
    expect(inQuietHours(ist("2026-10-20T13:30:00"), daytime)).toBe(true)
    expect(inQuietHours(ist("2026-10-20T14:30:00"), daytime)).toBe(false)
    const dubai = { ...profile, timezone: "Asia/Dubai" }
    // 22:00 IST is 20:30 in Dubai: not quiet there
    expect(inQuietHours(ist("2026-10-20T22:00:00"), dubai)).toBe(false)
  })

  it("a report's window ends 2 hours later or at quiet hours, whichever is first", () => {
    expect(reportWindowEnd(ist("2026-10-20T18:00:00"), profile)).toEqual(
      ist("2026-10-20T20:00:00")
    )
    expect(reportWindowEnd(ist("2026-10-20T20:30:00"), profile)).toEqual(
      ist("2026-10-20T21:30:00")
    )
  })

  it("report retries wait the owner's gap and never enter quiet hours", () => {
    expect(reportRetryAt(ist("2026-10-20T18:00:00"), profile, 10)).toEqual(
      ist("2026-10-20T18:10:00")
    )
    expect(reportRetryAt(ist("2026-10-20T21:25:00"), profile, 10)).toBeNull()
  })
})
