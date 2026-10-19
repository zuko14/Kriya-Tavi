// GST rules Kriya applies in code (AD-16). Pure: no database, no next/*,
// so the worker, the web and tests share it (CHANGE_IMPACT §4).
//
// Sources (RG-5, read 2026-10-18; status.md, Phase A7):
// - CGST Rule 46 (CBIC): invoice particulars, incl. "central tax, State
//   tax, integrated tax, Union territory tax or cess".
// - CGST Act s. 2(114) (CBIC): the Union territories.
// - GSTIN structure: ICAI Indirect Taxes Committee, "Structure of GSTIN".
// NOT from a primary source (owner-approved, warn-only): the two-digit state
// codes below and the check-character algorithm. Verify both with GSTN.

export const STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (before division)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "96": "Foreign country",
  "97": "Other territory",
  "99": "Centre jurisdiction",
}

// CGST Act s. 2(114): these are taxed with Union territory tax, not State tax
const UNION_TERRITORIES = new Set(["35", "31", "25", "26", "38", "04", "97"])

export const isUnionTerritory = (code: string) => UNION_TERRITORIES.has(code)
export const stateTaxLabel = (code: string) => (isUnionTerritory(code) ? "UTGST" : "SGST")
export const stateName = (code: string) => STATE_CODES[code] ?? null

/* ────────────────────────────── GSTIN ───────────────────────────── */

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

// The 15th character. ponytail: the mod-36 scheme common public
// implementations use (alternate weights 1 and 2, digits of each product in
// base 36 summed); no official text was found, so a mismatch is only a
// reason to review, never a rejection. Replace when GSTN publishes it.
export function gstinCheckChar(first14: string) {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = CHARS.indexOf(first14[i])
    if (value < 0) return null
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return CHARS[(36 - (sum % 36)) % 36]
}

export const normaliseGstin = (value: string) => value.replace(/\s+/g, "").toUpperCase()

// Why a GSTIN looks wrong, in the person's words; empty when it looks right.
// Checks shape by registration type (ICAI): regular ones carry a PAN.
export function gstinProblems(value: string): string[] {
  const g = normaliseGstin(value)
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(g)) {
    return ["The GSTIN isn't 15 letters and digits starting with a state code."]
  }
  const problems: string[] = []
  const state = g.slice(0, 2)
  if (!STATE_CODES[state])
    problems.push(`The GSTIN's state code ${state} isn't one Kriya knows.`)
  // Non-resident and OIDAR registrations (state code 99) don't carry a PAN
  if (state !== "99" && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(g.slice(2, 12))) {
    problems.push("The GSTIN's characters 3–12 don't look like a PAN.")
  }
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) {
    problems.push(
      "The GSTIN's last character doesn't match Kriya's check (not an official check). Look it up on the GST portal."
    )
  }
  return problems
}

export const gstinState = (value: string) => normaliseGstin(value).slice(0, 2)

/* ────────────────────────────── taxes ───────────────────────────── */

// paise × rate in basis points ÷ parts, rounded half away from zero, in
// BigInt so no float touches a stored amount (as lib/money.ts). parts = 2
// halves the rate without a fractional rate (0.25 % = 25 bps)
export function percentOf(paise: number, bps: number, parts = 1) {
  const n = BigInt(paise) * BigInt(bps)
  const d = 10000n * BigInt(parts)
  const half = d / 2n
  return Number(n >= 0n ? (n + half) / d : (n - half) / d)
}

export type TaxSplit = { cgst: number; sgst: number; igst: number; interState: boolean }

// Within one State or Union territory: central tax + State (or UT) tax at
// half the rate each; across them, or abroad: integrated tax (AT-LED-02)
export function taxSplit(input: {
  supplierState: string
  placeOfSupply: string
  taxablePaise: number
  rateBps: number
}): TaxSplit {
  const interState = input.supplierState !== input.placeOfSupply
  if (interState) {
    return {
      cgst: 0,
      sgst: 0,
      igst: percentOf(input.taxablePaise, input.rateBps),
      interState,
    }
  }
  const half = percentOf(input.taxablePaise, input.rateBps, 2)
  return { cgst: half, sgst: half, igst: 0, interState }
}
