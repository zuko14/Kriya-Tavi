import { sql } from "drizzle-orm"
import { z } from "zod"

import { privileged, rowsOf } from "@/db"
import { getSetting } from "@/lib/config"
import { previewStore } from "@/lib/editing/previews"
import { EditingPreviewRequest } from "@/lib/harness/contract"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// Track E, EDD-46: reserves room for one file of this computer's job, in SQL, and
// answers a signed link. The bytes go straight to Storage (EH-23).

const REFUSED: [RegExp, number, string, string][] = [
  [/edit job not open/, 404, "not_found", "Not found."],
  [/too large/, 413, "too_large", "That file is over the limit for a preview."],
  [/not in plan/, 403, "cap_reached", "Your plan doesn't keep previews."],
  [/cap reached/, 403, "cap_reached", "Your plan's room for previews is full."],
  [/preview exists/, 409, "exists", "This job already has that file."],
]

export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("editing.previews")) !== "on")
    return fail(404, "not_found", "Not found.")
  const job = z.uuid().safeParse(new URL(request.url).pathname.split("/").at(-2)).data
  if (!job) return fail(404, "not_found", "Not found.")
  const body = await readBody(request, EditingPreviewRequest)
  if (body instanceof Response) return body
  const store = previewStore()
  if (!store) return fail(503, "unavailable", "Previews aren't available right now.")
  const max = Number(await getSetting("editing.previewMaxBytes"))
  const days = Number(await getSetting("editing.previewDays"))
  try {
    const [row] = rowsOf<{ id: string; storage_path: string }>(
      await privileged.execute(sql`
        select * from kriya.reserve_edit_preview(
          ${device.id}, ${device.deviceId}, ${job}, ${body.kind}, ${body.bytes}, ${body.sha256},
          ${body.durationFlicks ?? null}, ${max}, ${days})`)
    )
    return ok({ id: row.id, uploadUrl: await store.uploadUrl(row.storage_path) })
  } catch (error) {
    const text = `${(error as Error).message} ${String((error as Error).cause ?? "")}`
    const known = REFUSED.find(([pattern]) => pattern.test(text))
    if (known) return fail(known[1], known[2], known[3])
    throw error
  }
})
