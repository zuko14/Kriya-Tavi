import { describe, expect, it } from "vitest"

import { luhnValid, sensitiveKind, verhoeffValid } from "@/lib/memory/sensitive"

// AT-MEM-04: values that must never become memory, and look-alikes that may.
// Every number here is synthetic.

describe("check digits", () => {
  it("Luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true)
    expect(luhnValid("4111111111111112")).toBe(false)
  })

  it("Verhoeff (worked example: 236 → check digit 3)", () => {
    expect(verhoeffValid("2363")).toBe(true)
    expect(verhoeffValid("2364")).toBe(false)
  })
})

const agent = { slot: null, source: "agent" as const }

describe("refused (AT-MEM-04)", () => {
  it.each([
    ["card", "Card 4111 1111 1111 1111 exp 09/29"],
    ["card", "card no 4111-1111-1111-1111"],
    ["card", "Amex 3782 822463 10005"],
    ["card", "4111111111111111"],
    ["aadhaar", "Aadhaar 2341 2341 2346"],
    ["aadhaar", "aadhar no: 234123412346"],
    ["password", "Gmail password is Tiger@123"],
    ["password", "wifi pwd: chai4all"],
    ["password", "My password for the college portal is ravi1999"],
    ["otp", "OTP 482913 for login"],
    ["otp", "verification code is 5521"],
    ["cvv", "CVV 123"],
    ["pin", "UPI PIN 4321"],
    ["pin", "atm pin is 9876"],
    ["bank", "A/c 50100234567891, IFSC HDFC0001234"],
    ["pan", "PAN ABCDE1234F"],
    ["gstin", "GSTIN 36ABCDE1234F1Z5"],
  ])("%s: %s", (kind, text) => {
    expect(sensitiveKind(text, agent)).toBe(kind)
  })

  it("refuses PAN and GSTIN from an agent even in their slots", () => {
    expect(sensitiveKind("ABCDE1234F", { slot: "profile.pan", source: "agent" })).toBe(
      "pan"
    )
  })
})

describe("allowed (AT-MEM-04 negatives)", () => {
  it.each([
    "Rent is ₹1,20,000 a year",
    "Budget 150000 for the laptop",
    "Order 402-1234567-1234567 arrived",
    "Amazon order #171-5567890-3345210",
    "Call Ravi on 98765 43210",
    "Mobile +91 9876543210",
    "Exam on 2026-11-02, results 15/12/2026",
    "Pincode 500032",
    "PIN code is 500081",
    "Uses a password manager",
    "Prefers OTP login over passwords",
    "Student id 21B81A0512",
    "IFSC codes confuse him",
    "Version 4.11.1111",
  ])("%s", (text) => {
    expect(sensitiveKind(text, agent)).toBeNull()
  })

  it("allows PAN and GSTIN only in their own slots, written by the person", () => {
    expect(
      sensitiveKind("ABCDE1234F", { slot: "profile.pan", source: "user" })
    ).toBeNull()
    expect(
      sensitiveKind("36ABCDE1234F1Z5", { slot: "profile.gstin", source: "user" })
    ).toBeNull()
    // Not in another slot, even from the person
    expect(sensitiveKind("ABCDE1234F", { slot: "profile.notes", source: "user" })).toBe(
      "pan"
    )
  })
})
