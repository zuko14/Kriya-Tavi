import type { EmailOtpType } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"

import { safeNext } from "@/lib/auth"
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

  const target = request.nextUrl.clone()
  target.search = ""
  if (ok) {
    target.pathname = next
  } else {
    target.pathname = "/login"
    target.searchParams.set("error", "link")
  }
  return NextResponse.redirect(target)
}
