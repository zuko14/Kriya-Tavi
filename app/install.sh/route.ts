import { appUrl } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { installScript } from "@/lib/harness/install"

// S-2 (docs/kriya-harness/INSTALLER.md): `curl -fsSL <Kriya>/install.sh | sh`.
// Only with harness.api and harness.installScript on; otherwise 404. The
// sign-in address is this Kriya's configured KRIYA_APP_URL, never the
// request's Host header (a cached copy must not carry someone else's).

export const dynamic = "force-dynamic"

export async function GET() {
  if (
    (await getSetting("harness.api")) !== "on" ||
    (await getSetting("harness.installScript")) !== "on"
  )
    return new Response("Not found.\n", {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  return new Response(installScript(appUrl()), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })
}
