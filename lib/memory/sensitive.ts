// Values that must never become memory (AGENTS.md track A rule 8): card
// numbers, Aadhaar numbers, passwords, OTPs, CVVs, PINs, bank account + IFSC
// pairs. PAN and GSTIN are kept only in their own profile slot, and only when
// the person wrote them. Deterministic, no model: a refusal tells the agent
// why, so it can leave the value out and save the rest.
//
// Errs towards refusing. A false positive costs one rephrased note; a false
// negative stores a secret.

export type SensitiveKind =
  "password" | "otp" | "cvv" | "pin" | "bank" | "card" | "aadhaar" | "gstin" | "pan"

const PHRASES: [SensitiveKind, RegExp][] = [
  ["password", /\b(?:password|passwd|pwd|passcode)\b[^.\n]{0,40}?(?:\bis\b|[:=])\s*\S/i],
  [
    "otp",
    /\b(?:otp|one[- ]time (?:password|code)|verification code|security code)\b\D{0,20}\d{4,8}\b/i,
  ],
  ["cvv", /\b(?:cvv2?|cvc2?|cid)\b\D{0,10}\d{3,4}\b/i],
  ["pin", /\b(?:upi|atm|card|m)[ -]?pin\b\D{0,15}\d{4,6}\b/i],
  // "pin code" / "pincode" is a postal code, not a secret
  ["pin", /\bpin\b(?![ -]?code)\s*(?:is|=|:)?\s*\d{4,6}\b/i],
]

const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/
const ACCOUNT = /(?<!\d)\d{9,18}(?!\d)/
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/
// Digits, optionally grouped by single spaces or dashes
const NUMBER_RUN = /(?<!\w)\d+(?:[ -]\d+)*(?!\w)/g

export function luhnValid(digits: string) {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

// Aadhaar's last digit is a Verhoeff check digit
export function verhoeffValid(digits: string) {
  let c = 0
  for (let i = 0; i < digits.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(digits[digits.length - 1 - i])]]
  }
  return c === 0
}

// How cards are written: one block, fours (4-4-4-4, 4-4-4-4-3), or 4-6-5 /
// 4-6-4. Order ids like 402-1234567-1234567 aren't.
function cardShaped(groups: number[]) {
  if (groups.length === 1) return true
  const shape = groups.join("-")
  if (shape === "4-6-5" || shape === "4-6-4") return true
  const last = groups[groups.length - 1]
  return groups.slice(0, -1).every((g) => g === 4) && last >= 1 && last <= 4
}

function numberRuns(text: string) {
  return [...text.matchAll(NUMBER_RUN)].map((match) => {
    const groups = match[0].split(/[ -]/)
    return { digits: groups.join(""), groups: groups.map((g) => g.length) }
  })
}

export function sensitiveKind(
  text: string,
  { slot, source }: { slot: string | null; source: "agent" | "user" | "derived" }
): SensitiveKind | null {
  for (const [kind, pattern] of PHRASES) if (pattern.test(text)) return kind
  if (IFSC.test(text) && ACCOUNT.test(text)) return "bank"

  for (const { digits, groups } of numberRuns(text)) {
    if (digits.length >= 13 && digits.length <= 19 && cardShaped(groups)) {
      if (luhnValid(digits)) return "card"
    }
    if (
      digits.length === 12 &&
      (groups.length === 1 || groups.join("-") === "4-4-4") &&
      /^[2-9]/.test(digits) &&
      verhoeffValid(digits)
    ) {
      return "aadhaar"
    }
  }

  const ownSlot = (name: string) => slot === name && source === "user"
  if (GSTIN.test(text) && !ownSlot("profile.gstin")) return "gstin"
  if (PAN.test(text) && !ownSlot("profile.pan")) return "pan"
  return null
}

export const SENSITIVE_REFUSAL: Record<SensitiveKind, string> = {
  password: "a password",
  otp: "a one-time code",
  cvv: "a card security code",
  pin: "a PIN",
  bank: "a bank account number with its IFSC",
  card: "a card number",
  aadhaar: "an Aadhaar number",
  gstin: "a GSTIN",
  pan: "a PAN",
}
