import { HandoffMeta } from "@/lib/harness/contract"
import {
  checkHandoff,
  handoff,
  handoffProvider,
  maxPatchBytes,
} from "@/lib/harness/handoff"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// kriya handoff (H8, API_AND_CONTRACTS §7): multipart `meta` + `patch`.
// Size and digest are checked before anything is stored; 404 while
// harness.handoff or cloud workspaces are off
export const POST = harnessRoute(true, async (request, device) => {
  const provider = await handoffProvider()
  if (!provider) return fail(404, "not_found", "Not found.")
  // The body is buffered to parse it: refuse an oversized one before that
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > (await maxPatchBytes()) + 64 * 1024) {
    return fail(413, "too_large", "The changes are larger than a handoff allows.")
  }
  const form = await request.formData().catch(() => null)
  const metaPart = form?.get("meta")
  const patchPart = form?.get("patch")
  let json: unknown
  try {
    json = typeof metaPart === "string" ? JSON.parse(metaPart) : undefined
  } catch {}
  const meta = HandoffMeta.safeParse(json)
  if (!meta.success || !(patchPart instanceof Blob)) {
    return fail(400, "bad_request", "That request isn't what this API expects.")
  }
  const patch = Buffer.from(await patchPart.arrayBuffer())
  const result =
    (await checkHandoff(device, meta.data, patch)) ??
    (await handoff(device, provider, meta.data, patch))
  if ("error" in result) return fail(result.status, result.error, result.message)
  return ok(result, 201)
})
