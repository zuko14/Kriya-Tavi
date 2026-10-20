import { sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import { log } from "@/lib/log"

import { checkRollbacks, computeMissingMetrics, groupCases } from "./improve"
import { chargeFinishedVoiceTasks } from "./metering"

// Voice upkeep the worker's janitor runs (DATA_MODEL §5, COST_AND_METERING
// §4, the privacy notice's retention promise). Each step is idempotent and
// its failure is logged without stopping the others.

// What was said on a call is kept for the owner's chosen number of days
// (voice_profiles.transcript_retention_days; 30 without a profile), counted
// from the attempt's end. 0 keeps only the outcome. A transcript whose
// outcome is still being checked is kept until it's done.
export async function pruneTranscripts() {
  const result = await privileged.execute(sql`
    delete from kriya.conversation_turns t
    using kriya.call_attempts a
    left join kriya.voice_profiles p on p.user_id = a.user_id
    where t.call_attempt_id = a.id
      and a.ended_at is not null
      and a.ended_at < now() - make_interval(days => coalesce(p.transcript_retention_days, 30))
      and not exists (
        select 1 from kriya.call_outcomes o
        where o.call_attempt_id = a.id and o.verifier_status = 'pending')
    returning t.id`)
  const deleted = rowsOf(result).length
  if (deleted) log.info("voice transcripts past retention deleted", { turns: deleted })
  return deleted
}

// Metrics before pruning, so a short retention still leaves its signals
const STEPS: [string, () => Promise<unknown>][] = [
  ["charges", chargeFinishedVoiceTasks],
  ["metrics", computeMissingMetrics],
  ["cases", groupCases],
  ["rollbacks", checkRollbacks],
  ["transcripts", pruneTranscripts],
]

export async function voiceHousekeeping() {
  for (const [name, step] of STEPS) {
    await step().catch((error) =>
      log.error("voice housekeeping failed", { step: name, error })
    )
  }
}
