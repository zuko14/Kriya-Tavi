import { deviceSkills } from "@/lib/harness/skills"
import { fail, harnessRoute } from "@/lib/harness/route"

// One listed skill's instructions, as text/markdown, from the same loader
// as the cloud; a skill or version the device's list doesn't have is 404
export const GET = harnessRoute(true, async (request, device) => {
  const [id, version] = new URL(request.url).pathname.split("/").slice(-2)
  const { skills, load } = await deviceSkills(device)
  if (!skills.some((s) => s.id === id && s.version === version))
    return fail(404, "not_found", "Not found.")
  let text: string
  try {
    text = load(id, version)
  } catch {
    return fail(404, "not_found", "Not found.")
  }
  return new Response(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    },
  })
})
