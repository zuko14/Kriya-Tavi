import type { Metadata } from "next"
import Link from "next/link"

import { AuthCard } from "@/components/auth/auth-kit"
import { ForgotForm } from "@/components/auth/forms"

export const metadata: Metadata = { title: "Reset your password" }

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter the email you signed up with and we'll send a link to choose a new password."
      footer={
        <Link href="/login" className="font-medium text-rigel hover:underline">
          ← Back to sign in
        </Link>
      }
    >
      <ForgotForm />
    </AuthCard>
  )
}
