import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { OnboardingForm } from "@/components/account/forms"
import { AuthCard } from "@/components/auth/auth-kit"
import { requireUser } from "@/lib/auth"

export const metadata: Metadata = { title: "Welcome" }

export default async function OnboardingPage() {
  const user = await requireUser()
  if (user.profile.onboardedAt) redirect("/home")
  return (
    <AuthCard
      title="Welcome to Kriya"
      subtitle="Two quick questions, and we'll set up your first agent. You can change everything later."
    >
      <OnboardingForm profile={user.profile} />
    </AuthCard>
  )
}
