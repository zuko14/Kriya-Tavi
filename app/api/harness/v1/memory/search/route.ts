import { MemorySearchRequest } from "@/lib/harness/contract"
import { memoryOn, searchNotes } from "@/lib/harness/memory"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// The notes the device's agent can see (H7), confirmed ones first
export const POST = harnessRoute(true, async (request, device) => {
  if (!(await memoryOn())) return fail(404, "not_found", "Not found.")
  const body = await readBody(request, MemorySearchRequest)
  if (body instanceof Response) return body
  if (!device.agentId) return ok({ notes: [] })
  const notes = await searchNotes(
    { ...device, agentId: device.agentId },
    body.query,
    body.limit
  )
  return ok({ notes })
})
