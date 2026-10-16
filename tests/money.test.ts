import { describe, expect, it } from "vitest"

import {
  applyMarkup,
  creditsToMicroUsd,
  estimateMicroUsd,
  parseRate,
  priceTask,
  sumTaskCost,
  usdToInr,
} from "@/lib/money"

describe("money", () => {
  it("parses exchange rates exactly", () => {
    expect(parseRate("84.25")).toBe(842500n)
    expect(parseRate("84.2537")).toBe(842537n)
    expect(parseRate("84")).toBe(840000n)
    for (const bad of ["", "abc", "-1", "84.25391", "0", undefined, "1e3"]) {
      expect(parseRate(bad)).toBeNull()
    }
  })

  it("converts USD to INR with half-up rounding, no float drift", () => {
    // $0.000091 at ₹84.25 = ₹0.00766675 → 7667 micro-INR
    expect(usdToInr(91, 842500n)).toBe(7667)
    expect(usdToInr(1_000_000, 842500n)).toBe(84_250_000)
    expect(usdToInr(0, 842500n)).toBe(0)
  })

  it("applies markup in basis points", () => {
    expect(applyMarkup(1000, 10000)).toBe(1000)
    expect(applyMarkup(1000, 15000)).toBe(1500)
    expect(applyMarkup(3, 15000)).toBe(5)
  })

  it("reads OpenRouter credits without float error", () => {
    expect(creditsToMicroUsd(0.000091)).toBe(91)
    expect(creditsToMicroUsd(0.1 + 0.2)).toBe(300000)
    expect(creditsToMicroUsd(1.2345675)).toBe(1234568)
    expect(creditsToMicroUsd(0)).toBe(0)
    expect(creditsToMicroUsd(undefined)).toBeNull()
    expect(creditsToMicroUsd(-1)).toBeNull()
    expect(creditsToMicroUsd("0.1")).toBeNull()
  })

  it("estimates from catalogue prices only when everything is known", () => {
    // 10k in at $0.091/M + 2k out at $0.182/M = $0.000910 + $0.000364
    expect(
      estimateMicroUsd(
        { input: 10_000, output: 2_000 },
        { input: 91_000, output: 182_000 }
      )
    ).toBe(1274)
    expect(
      estimateMicroUsd({ input: null, output: 2_000 }, { input: 1, output: 1 })
    ).toBeNull()
    expect(
      estimateMicroUsd({ input: 1, output: 1 }, { input: null, output: 1 })
    ).toBeNull()
  })

  it("never treats a request without usage as free", () => {
    expect(sumTaskCost([])).toEqual({ costMicroUsd: 0, basis: "none", unmetered: 0 })
    expect(
      sumTaskCost([
        { costMicroUsd: 100, estimatedCostMicroUsd: null },
        { costMicroUsd: 50, estimatedCostMicroUsd: 999 },
      ])
    ).toEqual({ costMicroUsd: 150, basis: "provider", unmetered: 0 })
    expect(
      sumTaskCost([
        { costMicroUsd: 100, estimatedCostMicroUsd: null },
        { costMicroUsd: null, estimatedCostMicroUsd: 40 },
        { costMicroUsd: null, estimatedCostMicroUsd: null },
      ])
    ).toEqual({ costMicroUsd: 140, basis: "estimate", unmetered: 1 })
  })

  it("prices a task: final, estimated or unpriced", () => {
    const fx = { rate: "84.25", source: "test" }
    const final = priceTask(
      [{ costMicroUsd: 1_000_000, estimatedCostMicroUsd: null }],
      fx,
      15000
    )
    expect(final).toMatchObject({
      status: "final",
      providerCostMicroInr: 84_250_000,
      chargeMicroInr: 126_375_000,
      fxUsdInr: "84.2500",
    })
    const estimated = priceTask(
      [{ costMicroUsd: null, estimatedCostMicroUsd: 10 }],
      fx,
      10000
    )
    expect(estimated.status).toBe("estimated")
    const unpriced = priceTask(
      [{ costMicroUsd: 10, estimatedCostMicroUsd: null }],
      { rate: undefined, source: undefined },
      10000
    )
    expect(unpriced).toMatchObject({
      status: "unpriced",
      chargeMicroInr: null,
      providerCostMicroUsd: 10,
    })
  })
})
