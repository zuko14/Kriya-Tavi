import { desc, eq } from "drizzle-orm"
import { z } from "zod"

import { privileged } from "@/db"
import {
  harnessScoutFindings,
  harnessScoutRuns,
  harnessScoutSources,
  SCOUT_DISCIPLINES,
  SCOUT_SOURCE_KINDS,
} from "@/db/schema"

// Harness 2.0 W7: the Scout's sources, runs and findings for the owner's page
// (upgrade_2.0/SELF_EVOLUTION.md §2.2). Only the owner adds a source, after
// reading the page themselves; nothing here is reachable without requireOwner()
// (actions/harness-evolve.ts, app/owner/harness/page.tsx). An empty list by
// default (WD-14).

export const NewScoutSource = z.strictObject({
  discipline: z.enum(SCOUT_DISCIPLINES),
  kind: z.enum(SCOUT_SOURCE_KINDS),
  url: z
    .url({ protocol: /^https$/, hostname: z.regexes.domain })
    .max(500)
    .refine(
      (u) => !/[\s]/.test(u) && !new URL(u).username && !new URL(u).password,
      "A plain https address, without a user name or password"
    ),
})

export async function addScoutSource(input: unknown, ownerId: string) {
  const source = NewScoutSource.parse(input)
  const [row] = await privileged
    .insert(harnessScoutSources)
    .values({ ...source, url: new URL(source.url).href, createdBy: ownerId })
    .onConflictDoNothing()
    .returning({ id: harnessScoutSources.id })
  return row ?? null
}

export async function setScoutSourceActive(id: string, active: boolean) {
  z.uuid().parse(id)
  await privileged
    .update(harnessScoutSources)
    .set({ active })
    .where(eq(harnessScoutSources.id, id))
}

export async function scoutOverview() {
  const [sources, runs, findings] = await Promise.all([
    privileged
      .select()
      .from(harnessScoutSources)
      .orderBy(harnessScoutSources.discipline, harnessScoutSources.createdAt),
    privileged
      .select()
      .from(harnessScoutRuns)
      .orderBy(desc(harnessScoutRuns.startedAt))
      .limit(10),
    privileged
      .select({
        id: harnessScoutFindings.id,
        discipline: harnessScoutFindings.discipline,
        kind: harnessScoutFindings.kind,
        claim: harnessScoutFindings.claim,
        quote: harnessScoutFindings.quote,
        status: harnessScoutFindings.status,
        corroborated: harnessScoutFindings.corroborated,
        firstSeenAt: harnessScoutFindings.firstSeenAt,
        confirmedAt: harnessScoutFindings.confirmedAt,
        url: harnessScoutSources.url,
      })
      .from(harnessScoutFindings)
      .innerJoin(
        harnessScoutSources,
        eq(harnessScoutSources.id, harnessScoutFindings.sourceId)
      )
      .orderBy(desc(harnessScoutFindings.firstSeenAt))
      .limit(40),
  ])
  return { sources, runs, findings }
}
