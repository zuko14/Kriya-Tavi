import type { Metadata } from "next"
import Link from "next/link"

import { SCOUT_DISCIPLINES, SCOUT_SOURCE_KINDS } from "@/db/schema"
import { Section, Table, Td } from "@/components/owner/ui"
import { FreezeScout, VersionControls } from "@/components/owner/harness-evolve/forms"
import { AddScoutSource, ScoutSourceToggle } from "@/components/owner/scout-forms"
import { requireOwner } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { candidateOverview } from "@/lib/harness/scout/proposal"
import { scoutOverview } from "@/lib/harness/scout/sources"
import { autoRollbacks, versionOverview } from "@/lib/harness/scout/versions"

export const metadata: Metadata = { title: "Harness evolve" }

// Harness 2.0 W7 (docs/kriya-harness/upgrade_2.0/SELF_EVOLUTION.md): the R&D
// Scout's sources, runs and findings. Findings are reading: each quote was
// found word for word in the page and again an hour later. W9: candidates
// drafted from them, each with its own proposal page; approval stores the
// owner's decision and serves nothing (versions and the overlay are W11).

const WHEN = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})
const when = (d: Date | null) => (d ? WHEN.format(d) : "—")

export default async function OwnerHarnessEvolve() {
  await requireOwner()
  const [on, everyDays, budget, overview, candidates, versions, overlay, rolled] =
    await Promise.all([
      getSetting("harness.scout"),
      getSetting("harness.scoutEveryDays"),
      getSetting("harness.scoutMonthlyInr"),
      scoutOverview(),
      candidateOverview(),
      versionOverview(),
      getSetting("harness.cartridgeOverlay"),
      autoRollbacks(),
    ])
  const { sources, runs, findings } = overview
  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Harness evolve
        </h1>
        <p className="text-[13px] text-muted-foreground">
          The Scout reads the sources you list, keeps what changed, and records findings
          whose quote it found word for word, twice, an hour apart. It proposes nothing on
          its own: every change to a cartridge will need your click.
        </p>
        <p className="text-[13px]">
          {on === "on" ? (
            <>
              Running every <strong>{everyDays}</strong> day(s), model budget{" "}
              <strong>₹{budget}</strong> a month
              {budget === "0" && " (it reads and compares pages, and calls no model)"}.
            </>
          ) : (
            <>
              The Scout is off (harness.scout in Config). Sources can be listed while it
              is off.
            </>
          )}
        </p>
        {on === "on" && <FreezeScout />}
      </header>

      <Section
        title="Versions"
        description={
          overlay === "on"
            ? "Served from here: the active version to every device, a canary to its share. Rollback takes effect on each device's next fetch."
            : "The overlay is off (harness.cartridgeOverlay): approved versions are stored, not served. Ship one through a reviewed commit to skills-harness/."
        }
      >
        {rolled.length > 0 && (
          <p
            role="status"
            className="rounded-md border border-destructive/40 p-3 text-[13px]"
          >
            The guard rolled back{" "}
            {rolled
              .map((r) => {
                const v = versions.find((x) => x.id === r.versionId)
                return v
                  ? `${v.cartridgeId.replace("kriya-role-", "")} ${v.version}`
                  : "a version"
              })
              .join(", ")}{" "}
            ({when(rolled[0].at)}): its verified rate fell below the active
            version&rsquo;s.
          </p>
        )}
        {versions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No approved version yet.</p>
        ) : (
          <Table head={["cartridge", "version", "state", "outcomes", ""]}>
            {versions.map((v) => (
              <tr key={v.id}>
                <Td>{v.cartridgeId.replace("kriya-role-", "")}</Td>
                <Td className="font-mono text-[11.5px]">{v.version}</Td>
                <Td>
                  {v.status.replace("_", " ")}
                  {v.status === "canary" && ` · ${v.canaryPct}%`}
                </Td>
                <Td>
                  {v.outcomes.steps
                    ? `${v.outcomes.verified}/${v.outcomes.steps} verified`
                    : "none counted"}
                </Td>
                <Td>
                  <VersionControls id={v.id} status={v.status} canaryPct={v.canaryPct} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Candidates"
        description="Drafted from confirmed findings and linted by code. Each needs a benchmark on your machine, then your decision."
      >
        {candidates.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No candidates yet.</p>
        ) : (
          <Table head={["cartridge", "drafted", "state", "verdict", ""]}>
            {candidates.map((c) => (
              <tr key={c.id}>
                <Td>{c.cartridgeId.replace("kriya-role-", "")}</Td>
                <Td className="font-mono text-[11.5px]">{when(c.createdAt)}</Td>
                <Td>{c.status.replace("_", " ")}</Td>
                <Td>{(c.verdict as { verdict?: string } | null)?.verdict ?? "—"}</Td>
                <Td>
                  <Link
                    href={`/owner/harness/candidates/${c.id}`}
                    className="inline-flex min-h-11 items-center text-rigel hover:underline"
                  >
                    Open
                  </Link>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Add a source"
        description="Only pages you have read yourself. The Scout fetches only what is listed here."
      >
        <AddScoutSource disciplines={SCOUT_DISCIPLINES} kinds={SCOUT_SOURCE_KINDS} />
      </Section>

      <Section title={`${sources.length} source(s)`}>
        {sources.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No sources yet. The list starts empty on purpose.
          </p>
        ) : (
          <Table head={["discipline", "address", "kind", "last read", "state", ""]}>
            {sources.map((s) => (
              <tr key={s.id}>
                <Td>{s.discipline}</Td>
                <Td className="font-mono text-[11.5px] break-all">{s.url}</Td>
                <Td>{s.kind.replace("_", " ")}</Td>
                <Td className="font-mono text-[11.5px]">{when(s.lastFetchedAt)}</Td>
                <Td>{s.active ? "active" : "paused"}</Td>
                <Td>
                  <ScoutSourceToggle id={s.id} active={s.active} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Runs">
        {runs.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No run yet.</p>
        ) : (
          <Table head={["started", "finished", "state", "sources read", "findings"]}>
            {runs.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono text-[11.5px]">{when(r.startedAt)}</Td>
                <Td className="font-mono text-[11.5px]">{when(r.finishedAt)}</Td>
                <Td>{r.status.replace("_", " ")}</Td>
                <Td>{r.sourcesFetched}</Td>
                <Td>{r.findings}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Findings"
        description="Waiting: read once; confirmed: still there an hour later; idea: reading only, never a change."
      >
        {findings.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No findings yet.</p>
        ) : (
          <Table head={["discipline", "finding", "quote and source", "state"]}>
            {findings.map((f) => (
              <tr key={f.id}>
                <Td>{f.discipline}</Td>
                <Td>
                  {f.claim}
                  <span className="block text-[11.5px] text-faint">
                    {f.kind.replace("_", " ")}
                    {f.corroborated ? " · corroborated" : " · single source"}
                  </span>
                </Td>
                <Td>
                  &ldquo;{f.quote}&rdquo;{" "}
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-rigel hover:underline"
                  >
                    {new URL(f.url).hostname}
                  </a>
                </Td>
                <Td>{f.status === "new" ? "waiting" : f.status}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  )
}
