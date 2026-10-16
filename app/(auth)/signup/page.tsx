import type { Metadata } from "next"
import Link from "next/link"

import { AuthCard } from "@/components/auth/auth-kit"
import { SignupForm } from "@/components/auth/forms"

export const metadata: Metadata = { title: "Create your account" }

export default function SignupPage() {
  return (
    <AuthCard
      title="Create your Kriya account"
      subtitle="Free to start. No card needed, and nothing to install."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-rigel hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm />
    </AuthCard>
  )
}
