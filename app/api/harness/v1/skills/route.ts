import { deviceSkills, etagOf } from "@/lib/harness/skills"
import { harnessRoute } from "@/lib/harness/route"

// The device agent's skills (H7): the cloud's catalogue rules with the
// device's belt; ETag, so an unchanged list answers 304
export const GET = harnessRoute(true, async (request, device) => {
  const { skills } = await deviceSkills(device)
  const etag = etagOf(skills)
  const headers = { "cache-control": "no-store", etag }
  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers })
  return Response.json({ skills }, { headers })
})
