import { describe, expect, it } from "vitest"

import {
  gstinCheckChar,
  gstinProblems,
  isUnionTerritory,
  percentOf,
  stateTaxLabel,
  taxSplit,
} from "@/lib/gst"

// lib/gst.ts. AT-LED-02: CGST+SGST (or UTGST) within a State or Union
// territory, IGST across. AT-LED-03 (partial, owner 2026-10-18): the GSTIN
// check character is Kriya's unofficial mod-36 check; no primary source
// gives the algorithm, so these vectors are synthetic (a made-up PAN), not
// real public GSTINs, and a mismatch is only a review reason.

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const withCheck = (first14: string) => first14 + gstinCheckChar(first14)

describe("AT-LED-02 which taxes apply", () => {
  it("intra-state: half the rate each as CGST and SGST", () => {
    expect(
      taxSplit({
        supplierState: "29",
        placeOfSupply: "29",
        taxablePaise: 1_000_000,
        rateBps: 1800,
      })
    ).toEqual({ cgst: 90_000, sgst: 90_000, igst: 0, interState: false })
  })

  it("inter-state: IGST at the full rate", () => {
    expect(
      taxSplit({
        supplierState: "29",
        placeOfSupply: "27",
        taxablePaise: 1_000_000,
        rateBps: 1800,
      })
    ).toEqual({ cgst: 0, sgst: 0, igst: 180_000, interState: true })
  })

  it("rounds each tax to the paisa, half away from zero, without floats", () => {
    // 5 % of ₹333.33 = ₹16.6665 → CGST and SGST 2.5 % each = ₹8.333325 → ₹8.33
    expect(
      taxSplit({
        supplierState: "07",
        placeOfSupply: "07",
        taxablePaise: 33_333,
        rateBps: 500,
      })
    ).toMatchObject({ cgst: 833, sgst: 833 })
    // 0.25 % halves to 0.125 % without a fractional rate
    expect(
      taxSplit({
        supplierState: "24",
        placeOfSupply: "24",
        taxablePaise: 1_000_000,
        rateBps: 25,
      })
    ).toMatchObject({ cgst: 1_250, sgst: 1_250 })
    expect(percentOf(1, 5000)).toBe(1) // 0.5 paisa rounds up
    expect(percentOf(Number.MAX_SAFE_INTEGER, 1)).toBe(900_719_925_474)
  })

  it("Union territories (CGST Act s. 2(114)) use UTGST; Delhi and Puducherry SGST", () => {
    for (const ut of ["35", "31", "26", "38", "04", "97"]) {
      expect(isUnionTerritory(ut), ut).toBe(true)
      expect(stateTaxLabel(ut)).toBe("UTGST")
    }
    for (const state of ["07", "34", "01", "29"])
      expect(stateTaxLabel(state), state).toBe("SGST")
  })
})

describe("AT-LED-03 GSTIN checks (unofficial check character)", () => {
  const valid = withCheck("29ABCDE1234F1Z")

  it("a well-formed GSTIN has no problems", () => {
    expect(gstinProblems(valid)).toEqual([])
    expect(gstinProblems(` ${valid.toLowerCase()} `)).toEqual([])
  })

  it("every single-character change is caught", () => {
    let caught = 0
    let tried = 0
    for (let i = 0; i < 15; i++) {
      for (const c of CHARS) {
        if (c === valid[i]) continue
        const changed = valid.slice(0, i) + c + valid.slice(i + 1)
        // Only changes that keep the basic shape reach the check character
        if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(changed)) continue
        tried++
        if (gstinProblems(changed).length > 0) caught++
      }
    }
    expect(tried).toBeGreaterThan(100)
    expect(caught).toBe(tried)
  })

  it("explains what's wrong, without rejecting a non-Z or non-resident GSTIN", () => {
    expect(gstinProblems("29ABCDE1234F1Z")).toEqual([
      "The GSTIN isn't 15 letters and digits starting with a state code.",
    ])
    expect(gstinProblems(withCheck("00ABCDE1234F1Z"))).toEqual([
      "The GSTIN's state code 00 isn't one Kriya knows.",
    ])
    expect(gstinProblems(withCheck("291234567890" + "1Z"))).toEqual([
      "The GSTIN's characters 3–12 don't look like a PAN.",
    ])
    // A tax deductor's registration ('D' at 14) and an OIDAR one (ICAI example)
    expect(gstinProblems(withCheck("29ABCDE1234F1D"))).toEqual([])
    expect(gstinProblems(withCheck("9917USA00015OS"))).toEqual([])
    const wrongCheck = valid.slice(0, 14) + (valid[14] === "A" ? "B" : "A")
    expect(gstinProblems(wrongCheck)).toEqual([
      "The GSTIN's last character doesn't match Kriya's check (not an official check). Look it up on the GST portal.",
    ])
  })
})
