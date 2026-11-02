import { z } from "zod"

import { getSetting } from "@/lib/config"
import { latestCheckpoint } from "@/lib/harness/handoff"
import { fail, harnessRoute } from "@/lib/harness/route"

// kriya pull (H8, API_AND_CONTRACTS §7): the latest checkpoint of one of
// the person's workspaces, exactly as stored; the client checks the digest
// again and applies it on kriya/pull-<id>

const idOf = (request: Request) =>
  z.uuid().safeParse(new URL(request.url).pathname.split("/").at(-2)).data

export const GET = harnessRoute(true, async (request, device) => {
  const id = idOf(request)
  if ((await getSetting("harness.handoff")) !== "on" || !id) {
    return fail(404, "not_found", "Not found.")
  }
  const found = await latestCheckpoint(device.id, id)
  if (!found) return fail(404, "not_found", "Not found.")
  if (found === "none") {
    return fail(404, "no_checkpoint", "This workspace has no changes saved yet.")
  }
  return new Response(new Uint8Array(found.patch), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(found.patch.length),
      "x-kriya-sha256": found.sha256,
      "x-kriya-base-sha": found.baseSha,
      "cache-control": "no-store",
    },
  })
})
