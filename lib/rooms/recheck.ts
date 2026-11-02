import { sql } from "drizzle-orm"

import { privileged, rowsOf } from "@/db"
import type { EpisodeAction, EpisodeClaim } from "@/db/schema"
import { CAPABILITIES } from "@/lib/agent/capabilities"
import { pingRoom } from "@/lib/rooms/realtime"

// The re-check relay (track R, R5; RD-09, CONVERSATION_PROTOCOL §6): when a
// late delivery re-check (track N) records a status for a run of a room
// task whose reply is in the room with a card, the room gets one system
// line about it. Once per check (the line names its check id); one worker
// at a time (an advisory lock). Runs from the owner's accounts or apps are
// never announced: their titles were never on the card. Reads track N's
// rows through its own query; writes only room system lines.

const PUBLIC_SYSTEMS = new Set(["kriya", "web", "browser", "workspace"])

const WORDS: Record<string, [string, string]> = {
  // [was on the card as verified, wasn't]
  verified: ["still verified", "now verified"],
  unverified: ["no longer verified", "still not verified"],
  failed: ["now failed", "failed"],
  gone: ["no longer found", "not found"],
}

type Row = {
  check_id: string
  status: string
  execution_id: string
  tool_name: string
  room_id: string
  message_id: string
  done: EpisodeAction[] | null
  unconfirmed: EpisodeClaim[] | null
}

export async function roomRecheckRelay() {
  const posted = await privileged.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kriya.rooms.recheck'))`)
    const rows = rowsOf<Row>(
      await tx.execute(
        sql`select d.id as check_id, d.status, d.execution_id, x.tool_name,
                   m.room_id, m.id as message_id, e.done, e.unconfirmed
            from kriya.delivery_checks d
            join kriya.tool_executions x on x.id = d.execution_id
            join kriya.room_messages m
              on m.task_id = d.task_id and m.author_kind = 'agent'
             and m.deleted_at is null and m.parts ? 'proof'
            join kriya.rooms r on r.id = m.room_id and r.status = 'active'
            left join kriya.episodes e on e.task_id = d.task_id and e.deleted_at is null
            where d.checked_at > now() - interval '7 days'
              and not exists (
                select 1 from kriya.room_messages s
                where s.room_id = m.room_id and s.author_kind = 'system'
                  and s.parts ->> 'checkId' = d.id::text)
            order by d.checked_at
            limit 50`
      )
    )
    const lines: { roomId: string; seq: number }[] = []
    for (const row of rows) {
      const system = CAPABILITIES[row.tool_name]?.system ?? ""
      if (row.tool_name.startsWith("mcp_") || !PUBLIC_SYSTEMS.has(system)) continue
      const onCard = row.done?.find((d) => d.executionId === row.execution_id)
      const claim = row.unconfirmed?.find((u) => u.executionId === row.execution_id)
      const title = onCard?.title ?? claim?.claim
      if (!title) continue
      const words = WORDS[row.status] ?? ["checked again", "checked again"]
      const [inserted] = rowsOf<{ seq: string | number }>(
        await tx.execute(
          sql`insert into kriya.room_messages (room_id, author_kind, body, parts)
              values (${row.room_id}, 'system',
                      ${`Re-checked “${title}”: ${onCard ? words[0] : words[1]}.`},
                      ${JSON.stringify({ kind: "recheck", checkId: row.check_id, messageId: row.message_id })}::jsonb)
              returning seq`
        )
      )
      lines.push({ roomId: row.room_id, seq: Number(inserted.seq) })
    }
    return lines
  })
  // After the commit: the content-free pings
  for (const line of posted) await pingRoom(line.roomId, line.seq)
  return { posted: posted.length }
}
