import type { EmailOtpType } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"

import { appUrl, safeNext } from "@/lib/auth"
import { createSupabase } from "@/lib/supabase"

// Where links in Supabase's emails land: sign-up confirmation, password
// recovery and email changes. Handles both the token-hash link (custom email
// templates, see docs/kriya/supabase.md) and the PKCE code of the defaults.
const TYPES: EmailOtpType[] = ["signup", "email", "recovery", "email_change", "invite"]

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const next = safeNext(params.get("next"))
  const tokenHash = params.get("token_hash")
  const type = params.get("type") as EmailOtpType | null
  const code = params.get("code")

  const supabase = await createSupabase()
  let ok = false
  if (tokenHash && type && TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    ok = !error
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    ok = !error
  }

  // A link that was already used (a second tap, or a mail app that opened it
  // first) fails here even though the account is confirmed. If that browser
  // is signed in anyway, carry on; otherwise /login says the account exists.
  if (!ok) ok = Boolean((await supabase.auth.getUser()).data.user)

  // The app's public address, not the host Next saw: the new session cookie
  // belongs to the address the email link used (Supabase's Site URL, which
  // must equal KRIYA_APP_URL), and a different host would drop it
  const target = new URL(appUrl())
  if (ok) {
    target.pathname = next
    if (next === "/onboarding") target.searchParams.set("confirmed", "1")
  } else {
    target.pathname = "/login"
    // A sign-up link means the account exists; others (reset, email change)
    // just expired
    target.searchParams.set("error", next === "/onboarding" ? "signup-link" : "link")
  }
  return NextResponse.redirect(target)
}
