import { runCommand, type BenchAgent } from "./run"

// The real client as a bench agent: `kriya run --mode auto "<job>"` in the
// task's folder (HD-20: auto writes only inside the folder and refuses
// anything that would need approval). Its spend is metered by Kriya's
// gateway in kriya.harness_usage. With `meter` (harness upgrade U4: e.g.
// `kriya usage --json`, the device's GET /me), the task's spend is the
// ledger's difference around the run, in micro-INR; one task runs at a time
// on the bench device, so nothing else is in that difference. Unknown when
// the meter fails or a request in between couldn't be priced.
export function commandAgent(argv: string[], meter?: string[]): BenchAgent {
  if (argv.length === 0) throw new Error("No agent command.")
  const read = async (cwd: string) => {
    if (!meter) return null
    const out = await runCommand(meter, { cwd, timeoutMs: 30_000, env: process.env })
    try {
      const me = JSON.parse(out.output.trim().split("\n").at(-1) ?? "")
      return Number.isSafeInteger(me.usedMicroInr) && Number.isSafeInteger(me.unpriced)
        ? { used: BigInt(me.usedMicroInr), unpriced: me.unpriced as number }
        : null
    } catch {
      return null
    }
  }
  return {
    name: argv.join(" "),
    async run({ cwd, prompt, timeoutMs }) {
      const before = await read(cwd)
      const turn = await runCommand([...argv, prompt], {
        cwd,
        timeoutMs,
        env: process.env,
      })
      const after = await read(cwd)
      const costMicroInr =
        before && after && after.unpriced === before.unpriced && after.used >= before.used
          ? after.used - before.used
          : null
      return { ...turn, costMicroUsd: null, costMicroInr }
    },
  }
}
