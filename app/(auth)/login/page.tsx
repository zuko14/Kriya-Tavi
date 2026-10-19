import type { Metadata } from "next"
import Link from "next/link"

import { AuthCard } from "@/components/auth/auth-kit"
import { LoginForm } from "@/components/auth/forms"
import { safeNext } from "@/lib/auth"

export const metadata: Metadata = { title: "Sign in" }

// A used or expired sign-up link usually means the account already exists (a
// mail app may have opened the link first), so it's said calmly, not as an error
const NOTICES: Record<string, { message?: string; error?: string }> = {
  "signup-link": {
    message:
      "Your account has been created. That email link was already used or has expired, so just sign in below. If your email still needs confirming, we'll offer a fresh link.",
  },
  link: {
    error: "That link has expired or was already used. Sign in, or ask for a new one.",
  },
  account: { error: "We couldn't load your account. Sign in again, or contact support." },
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next, error } = await searchParams
  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to pick up where your agents left off."
      footer={
        <>
          New to Kriya?{" "}
          <Link href="/signup" className="font-medium text-rigel hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <LoginForm next={safeNext(next)} notice={error ? NOTICES[error] : undefined} />
    </AuthCard>
  )
}
