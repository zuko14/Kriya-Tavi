import { chatCompletion } from "@/lib/harness/gateway"
import { harnessRoute } from "@/lib/harness/route"

// The model gateway (HD-06): OpenAI-compatible, tier aliases only
export const POST = harnessRoute(true, (request, device) =>
  chatCompletion(request, device)
)
