import { getSetting } from "@/lib/config"
import { OwnUsageRequest } from "@/lib/harness/contract"
import { recordOwnUsage } from "@/lib/harness/own-usage"
import { fail, harnessRoute, readBody } from "@/lib/harness/route"

// Own models (docs/kriya-harness/OWN_MODELS.md): counts from the person's own
// API keys, batched by the harness; no prompt, code or key
export const POST = harnessRoute(true, async (request, device) => {
  if ((await getSetting("harness.ownModels")) !== "on")
    return fail(404, "not_found", "Not found.")
  const body = await readBody(request, OwnUsageRequest)
  if (body instanceof Response) return body
  await recordOwnUsage(device, body)
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
})
