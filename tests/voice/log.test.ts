import { describe, expect, it } from "vitest"

import { __test } from "@/lib/log"

const clean = __test.clean as (value: unknown) => unknown

// T-LOG-01: phone numbers are personal data and never reach the logs
describe("T-LOG-01 phone numbers in logs", () => {
  it.each([
    "+919876543210",
    "+91 98765 43210",
    "+91-98765-43210",
    "91 98765 43210",
    "9876543210",
    "09876543210",
    "98765 43210",
    "+1 415 555 0100",
    "+447911123456",
  ])("redacts %s", (phone) => {
    const out = clean({ detail: `dialing ${phone} now` }) as { detail: string }
    expect(out.detail).toBe("dialing [redacted] now")
  })

  it("redacts numbers nested in objects and error messages", () => {
    expect(clean({ call: { to: "+919876543210" } })).toEqual({
      call: { to: "[redacted]" },
    })
    expect(clean(new Error("Exotel refused 9876543210"))).toEqual({
      name: "Error",
      message: "Exotel refused [redacted]",
    })
  })

  it.each([
    "₹1,20,000",
    "₹98,765.43",
    "8be4f52a-af77-4c39-9034-f352c3980123",
    "2026-10-20T09:46:00.000+05:30",
    "1760933160000",
    "1760933160",
    "20261020000000",
    "attempt 3 of 5",
    "cost 1500000 micro-INR",
    "v1.2.3",
    "12345678",
  ])("leaves %s alone", (value) => {
    expect(clean({ value })).toEqual({ value })
  })

  it("leaves numeric fields alone", () => {
    expect(clean({ chargeMicroInr: 9_000_000_000, seconds: 300 })).toEqual({
      chargeMicroInr: 9_000_000_000,
      seconds: 300,
    })
  })
})
