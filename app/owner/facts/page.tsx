import type { Metadata } from "next"

import { Section, Table, Td } from "@/components/owner/ui"
import { RetractFact } from "@/components/radar/controls"
import { requireOwner } from "@/lib/auth"
import { listAllFacts } from "@/lib/facts"

export const metadata: Metadata = { title: "Facts" }

// The public facts commons (K6): every fact with its quote, source and
// confirmations, and Retract (audited). Facts hold no personal data.

const WHEN = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})

export default async function OwnerFacts() {
  await requireOwner()
  const facts = await listAllFacts()
  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Public facts
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Official facts served to every agent once two fetches at least an hour apart
          agree. Sources are limited to the allow-listed official domains.
        </p>
      </header>
      <Section title={`${facts.length} fact(s)`}>
        {facts.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No facts yet. The fact job has no targets until some are listed.
          </p>
        ) : (
          <Table head={["key", "value", "quote and source", "confirmed", "state", ""]}>
            {facts.map((f) => {
              const state = f.retractedAt
                ? "retracted"
                : f.expired
                  ? "expired"
                  : f.confirmations >= 2
                    ? "served"
                    : "waiting"
              return (
                <tr key={f.key}>
                  <Td className="font-mono text-[11.5px]">{f.key}</Td>
                  <Td>{f.value}</Td>
                  <Td>
                    &ldquo;{f.quote}&rdquo;{" "}
                    <a
                      href={f.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-rigel hover:underline"
                    >
                      {f.sourceDomain}
                    </a>
                  </Td>
                  <Td className="font-mono text-[11.5px]">
                    {f.confirmations} · {WHEN.format(f.fetchedAt)}
                  </Td>
                  <Td>{state}</Td>
                  <Td>{!f.retractedAt && <RetractFact factKey={f.key} />}</Td>
                </tr>
              )
            })}
          </Table>
        )}
      </Section>
    </>
  )
}
