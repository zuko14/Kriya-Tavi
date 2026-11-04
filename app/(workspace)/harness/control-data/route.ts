import { getSessionUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { controlCenter } from "@/lib/harness/control"

// The Control Center's data for the page's polling (CONTROL_CENTER.md): a
// plain GET as the signed-in person, so polling never refreshes the route
// (a server action would). 404 while the switch is off.
export async function GET() {
  if (
    (await getSetting("harness.api")) !== "on" ||
    (await getSetting("harness.controlCenter")) !== "on"
  )
    return Response.json({ error: "Not found." }, { status: 404 })
  const user = await getSessionUser()
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 })
  return Response.json(await controlCenter(user.id), {
    headers: { "cache-control": "no-store" },
  })
}
