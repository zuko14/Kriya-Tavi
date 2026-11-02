import { MemorySaveRequest } from "@/lib/harness/contract"
import { memoryOn, saveNote } from "@/lib/harness/memory"
import { fail, harnessRoute, ok, readBody } from "@/lib/harness/route"

// A note from the device (H7): saved unconfirmed for the device's agent;
// the person confirms it in the Inbox
export const POST = harnessRoute(true, async (request, device) => {
  if (!(await memoryOn())) return fail(404, "not_found", "Not found.")
  const body = await readBody(request, MemorySaveRequest)
  if (body instanceof Response) return body
  if (!device.agentId)
    return fail(
      409,
      "no_agent",
      "Choose the agent this device works as in Kriya, Account → Devices."
    )
  const saved = await saveNote({ ...device, agentId: device.agentId }, body.content)
  if ("refused" in saved) return fail(400, "bad_request", saved.refused!)
  return ok(saved, 201)
})
