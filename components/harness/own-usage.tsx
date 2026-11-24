// Own models (docs/kriya-harness/OWN_MODELS.md): this month's calls through the
// person's own API keys, as the harness reported them. Kriya didn't pay for these;
// the cost is the provider's own figure, shown only when it reported every call.

type Row = {
  provider: string
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
  reportedCostMicroUsd: number | null
}

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : String(n)
// Display only: micro-USD to dollars (integers everywhere else, invariant 6)
export const usd = (micro: number | null) =>
  micro === null ? "—" : `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`

export function OwnUsage({ rows }: { rows: Row[] }) {
  if (!rows.length)
    return (
      <p className="glass rounded-[20px] px-4 py-3.5 text-[13px] text-muted-foreground">
        No calls through your own API keys this month. Add a key in Kriya Harness,
        Developer tab → Your models.
      </p>
    )
  return (
    <div className="glass overflow-hidden rounded-[20px]">
      <ul className="flex flex-col divide-y">
        {rows.map((r) => (
          <li
            key={`${r.provider}/${r.model}`}
            className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13px]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{r.model}</span>
              <span className="label-mono text-muted-foreground">{r.provider}</span>
            </span>
            <span className="text-right text-[12.5px] text-muted-foreground tabular-nums">
              {r.requests} {r.requests === 1 ? "call" : "calls"} · {tokens(r.inputTokens)}{" "}
              in · {tokens(r.outputTokens)} out
              <span className="block text-foreground">{usd(r.reportedCostMicroUsd)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
