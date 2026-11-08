import { getSetting } from "@/lib/config"
import { servedManifest } from "@/lib/editing/manifest"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// Track E, EDD-05: the Media Runtime for this client. Its 200 is how a client
// learns this server has editing (EH-01), so off it says nothing at all.
export const GET = harnessRoute(true, async () => {
  if ((await getSetting("editing.studio")) !== "on")
    return fail(404, "not_found", "Not found.")
  return ok(servedManifest((await getSetting("editing.runtimeChannel")) ?? "stable"))
})
