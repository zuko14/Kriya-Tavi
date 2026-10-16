import type { Metadata } from "next"
import Link from "next/link"

import { AuthCard } from "@/components/auth/auth-kit"
import { ResetForm } from "@/components/auth/forms"
import { getSessionUser } from "@/lib/auth"

export const metadata: Metadata = { title: "Choose a new password" }

// Reached from the recovery email: /auth/confirm signed the person in first
export default async function ResetPasswordPage() {
  const user = await getSessionUser()
  if (!user) {
    return (
      <AuthCard
        title="This link has expired"
        subtitle="Reset links work once and for a limited time. Ask for a new one."
        footer={
          <Link
            href="/forgot-password"
            className="font-medium text-rigel hover:underline"
          >
            Send a new reset link
          </Link>
        }
      >
        <p className="text-[13px] text-muted-foreground">
          If you remember your password, you can{" "}
          <Link href="/login" className="text-rigel hover:underline">
            sign in
          </Link>{" "}
          instead.
        </p>
      </AuthCard>
    )
  }
  return (
    <AuthCard
      title="Choose a new password"
      subtitle={`For ${user.email ?? "your account"}.`}
    >
      <ResetForm />
    </AuthCard>
  )
}
