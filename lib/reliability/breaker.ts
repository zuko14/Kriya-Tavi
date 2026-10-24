// A per-system circuit breaker (ND-05). State lives in this process only: a
// 60-second window isn't worth a table, and each worker learns on its own.
// While a system's circuit is open its reads fail at once with a message the
// model can pass on, so a dead provider doesn't eat the task's step budget.
// No next/* imports (the worker uses this too).

export const BREAKER = { failures: 5, windowMs: 60_000, openMs: 60_000 }

const NAMES: Record<string, string> = {
  google: "Google",
  notion: "Notion",
  github: "GitHub",
  meta: "Instagram",
}

export class AppUnavailableError extends Error {
  name = "AppUnavailableError"
  constructor(system: string) {
    super(
      `${NAMES[system] ?? system} isn't responding; Kriya stopped trying for a minute.`
    )
  }
}

type State = { failures: number[]; openUntil: number }
const states = new Map<string, State>()

// Throws while the system's circuit is open
export function assertClosed(system: string, now = Date.now()) {
  const state = states.get(system)
  if (state && state.openUntil > now) throw new AppUnavailableError(system)
}

// Counts one transient failure (the caller passes only those); the fifth
// within the window opens the circuit
export function record(system: string, now = Date.now()) {
  const state = states.get(system) ?? { failures: [], openUntil: 0 }
  state.failures = [...state.failures.filter((at) => now - at < BREAKER.windowMs), now]
  if (state.failures.length >= BREAKER.failures) {
    state.openUntil = now + BREAKER.openMs
    state.failures = []
  }
  states.set(system, state)
}

// Tests only
export function reset() {
  states.clear()
}
