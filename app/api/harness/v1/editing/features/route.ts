import { getSetting } from "@/lib/config"
import { fail, harnessRoute, ok } from "@/lib/harness/route"

// Track E, VISUAL_SCENES.md: what this server has switched on for editing, so a
// switch here reaches every computer. Off, editing says nothing at all (EH-01).
export const GET = harnessRoute(true, async () => {
  if ((await getSetting("editing.studio")) !== "on")
    return fail(404, "not_found", "Not found.")
  return ok({
    visuals: (await getSetting("editing.visuals")) === "on",
    playbooks: (await getSetting("editing.playbooks")) === "on",
    mediaSearch: (await getSetting("editing.mediaSearch")) === "on",
    motion: (await getSetting("editing.motion")) === "on",
    customMotion: (await getSetting("editing.customMotion")) === "on",
    assembly: (await getSetting("editing.assembly")) === "on",
    livePreview: (await getSetting("editing.livePreview")) === "on",
  })
})
