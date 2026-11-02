"use client"

import { BadgeCheckIcon, ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ProofCard as Card } from "@/queries/rooms"

// A proof card under an agent's room message (UX_SPEC §2, RD-09): what was
// verifiably done, copied by code from the run records, never the model's
// words. Collapsed: the counts and who verified it independently; open:
// each action with how it was checked and its links.

const METHOD: Record<string, string> = {
  api_readback: "checked with the service",
  page_check: "checked on the page",
  file: "checked the file",
  none: "not checked",
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function ProofCard({
  card,
  onVerify,
}: {
  card: Card
  // "Ask an agent to verify": absent where nobody can be asked
  onVerify?: () => void
}) {
  const verified = card.done.filter((d) => d.status === "verified").length
  const notVerified = card.unconfirmed + card.done.length - verified
  const checks = card.checks.supported + card.checks.unsupported
  return (
    <details className="group/proof w-full max-w-[85%] rounded-xl border bg-background/60 px-3 py-2 text-[12.5px]">
      <summary className="flex min-h-11 cursor-pointer list-none flex-col justify-center gap-0.5 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5 font-medium">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/proof:rotate-90" />
          {verified > 0 ? (
            <span className="text-rigel">
              ✓ {plural(verified, "action verified", "actions verified")}
            </span>
          ) : (
            <span>No verified actions</span>
          )}
          {notVerified > 0 && (
            <span className="text-muted-foreground">
              · {plural(notVerified, "claim not verified", "claims not verified")}
            </span>
          )}
        </span>
        {card.verifiedBy.map((v) => (
          <span key={v.agentId} className="flex items-center gap-1 pl-5 text-rigel">
            <BadgeCheckIcon className="size-3.5" /> Independently verified by{" "}
            {v.agentName} (owner: {v.ownerName})
          </span>
        ))}
      </summary>
      <div className="mt-2 flex flex-col gap-2 border-t pt-2">
        {card.done.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {card.done.map((item, i) => (
              <li key={i} className="flex flex-col gap-0.5">
                <span>
                  {item.title}{" "}
                  <span className="text-muted-foreground">
                    · {item.status === "verified" ? "" : `${item.status}, `}
                    {METHOD[item.method] ?? item.method}
                  </span>
                </span>
                {item.evidence.map((e) =>
                  e.kind === "url" && /^https:\/\//.test(e.value) ? (
                    <a
                      key={e.value}
                      href={e.value}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="flex min-h-11 items-center truncate font-mono text-[11.5px] text-rigel underline underline-offset-2 sm:min-h-0"
                    >
                      {e.value}
                    </a>
                  ) : (
                    <code key={e.value} className="truncate font-mono text-[11.5px]">
                      {e.value}
                    </code>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
        {card.unconfirmed > 0 && (
          <p className="text-muted-foreground">
            {plural(card.unconfirmed, "claim", "claims")} in the reply had no run behind
            {card.unconfirmed === 1 ? " it" : " them"}: not verified.
          </p>
        )}
        {checks > 0 && (
          <p className="text-muted-foreground">
            Quotes checked against their sources: {card.checks.supported} matched
            {card.checks.unsupported > 0 && `, ${card.checks.unsupported} didn't`}.
          </p>
        )}
        {onVerify && (
          <Button variant="outline" className="h-11 w-fit" onClick={onVerify}>
            Ask an agent to verify
          </Button>
        )}
      </div>
    </details>
  )
}
