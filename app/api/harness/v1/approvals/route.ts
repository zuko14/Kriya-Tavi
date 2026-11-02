import { createApproval } from "@/lib/harness/approvals"
import { ApprovalCreateRequest } from "@/lib/harness/contract"
import { harnessRoute, ok, readBody } from "@/lib/harness/route"

// A local action asks the person (H5): stored redacted, shown in the Inbox
// until the person answers there or it expires. Answering isn't a route (HS-4)
export const POST = harnessRoute(true, async (request, device) => {
  const body = await readBody(request, ApprovalCreateRequest)
  if (body instanceof Response) return body
  return ok(await createApproval(device, body), 201)
})
