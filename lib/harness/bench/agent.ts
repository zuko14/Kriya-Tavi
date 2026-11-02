import { runCommand, type BenchAgent } from "./run"

// The real client as a bench agent: `kriya run --mode auto "<job>"` in the
// task's folder (HD-20: auto writes only inside the folder and refuses
// anything that would need approval). Its spend is metered by Kriya's
// gateway in kriya.harness_usage, so the cost here stays unknown.
export function commandAgent(argv: string[]): BenchAgent {
  if (argv.length === 0) throw new Error("No agent command.")
  return {
    name: argv.join(" "),
    async run({ cwd, prompt, timeoutMs }) {
      const turn = await runCommand([...argv, prompt], {
        cwd,
        timeoutMs,
        env: process.env,
      })
      return { ...turn, costMicroUsd: null }
    },
  }
}
