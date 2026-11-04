import type { TaskResult } from "./run"

// KriyaBench statistics (harness upgrade U4, BENCHMARK_PLAN.md §4). A pass
// rate from a few dozen tasks is noisy: every rate is reported with its
// Wilson 95% interval, and two arms are compared on the same tasks (paired),
// counting only the tasks where they disagree. Integers in, integers or
// plain fractions out; nothing here calls a model.

const Z = 1.959964 // two-sided 95%

/** Wilson score interval for `passed` of `n`, in per mille (integers), or null for n = 0. */
export function wilsonPerMille(passed: number, n: number): [number, number] | null {
  if (n === 0) return null
  const p = passed / n
  const z2 = Z * Z
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return [
    Math.max(0, Math.floor((centre - half) * 1000)),
    Math.min(1000, Math.ceil((centre + half) * 1000)),
  ]
}

// C(n, k) / 2^n summed exactly enough for the n (≤ a few hundred) a bench has
function binomialTail(k: number, n: number) {
  let term = Math.pow(0.5, n) // C(n, 0) / 2^n
  let sum = 0
  for (let i = 0; i <= k; i++) {
    sum += term
    term = (term * (n - i)) / (i + 1)
  }
  return sum
}

/** Exact two-sided sign test (McNemar's exact test) on the discordant pairs. */
export function signTestP(onlyA: number, onlyB: number) {
  const n = onlyA + onlyB
  if (n === 0) return 1
  return Math.min(1, 2 * binomialTail(Math.min(onlyA, onlyB), n))
}

type Report = { seedVersion: string; results: TaskResult[] }

const valid = (r: Report) => r.results.filter((t) => t.status !== "invalid")

/**
 * One arm over several runs of the same seed set: the pooled pass rate with
 * its interval, pass^k (tasks that passed in every run) and the spend.
 */
export function armSummary(reports: Report[]) {
  const seeds = new Set(reports.map((r) => r.seedVersion))
  if (seeds.size > 1)
    throw new Error(`runs of different seed sets: ${[...seeds].join(", ")}`)
  const rows = reports.flatMap(valid)
  const passed = rows.filter((t) => t.status === "passed").length
  const ids = [...new Set(rows.map((t) => t.id))]
  const always = ids.filter((id) =>
    reports.every((r) => valid(r).some((t) => t.id === id && t.status === "passed"))
  ).length
  const costs = rows.map((t) => t.costMicroInr ?? null)
  const costMicroInr = costs.every((c) => c !== null)
    ? costs.reduce<bigint>((s, c) => s + c!, BigInt(0))
    : null
  return {
    runs: reports.length,
    attempts: rows.length,
    passed,
    passPerMille: rows.length ? Math.floor((passed * 1000) / rows.length) : 0,
    passCiPerMille: wilsonPerMille(passed, rows.length),
    tasks: ids.length,
    // pass^k: passed in every one of the k runs
    passAllRunsPerMille: ids.length ? Math.floor((always * 1000) / ids.length) : 0,
    costMicroInr,
    costPerPassedMicroInr:
      costMicroInr !== null && passed > 0 ? costMicroInr / BigInt(passed) : null,
  }
}

/**
 * Arm B against arm A on the same tasks and run index (run i of A with run
 * i of B): how many pairs only A passed, only B passed, and the exact sign
 * test on those. p < 0.05 with onlyB > onlyA is evidence that B is better on
 * this seed set, nothing more (BENCHMARK_PLAN.md §5).
 */
export function compareArms(a: Report[], b: Report[]) {
  const runs = Math.min(a.length, b.length)
  let both = 0
  let neither = 0
  let onlyA = 0
  let onlyB = 0
  for (let i = 0; i < runs; i++) {
    if (a[i].seedVersion !== b[i].seedVersion)
      throw new Error(`run ${i + 1}: seed ${a[i].seedVersion} vs ${b[i].seedVersion}`)
    const passedB = new Map(valid(b[i]).map((t) => [t.id, t.status === "passed"]))
    for (const t of valid(a[i])) {
      const other = passedB.get(t.id)
      if (other === undefined) continue
      const mine = t.status === "passed"
      if (mine && other) both++
      else if (mine) onlyA++
      else if (other) onlyB++
      else neither++
    }
  }
  return {
    pairs: both + neither + onlyA + onlyB,
    both,
    neither,
    onlyA,
    onlyB,
    p: signTestP(onlyA, onlyB),
    a: armSummary(a.slice(0, runs)),
    b: armSummary(b.slice(0, runs)),
  }
}
