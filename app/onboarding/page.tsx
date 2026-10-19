import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { OnboardingForm } from "@/components/account/forms"
import { AuthCard, StateNotice } from "@/components/auth/auth-kit"
import { TeamOnboarding } from "@/components/onboarding/team"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"

export const metadata: Metadata = { title: "Welcome" }

const CONFIRMED = { message: "Email confirmed. Your Kriya account is ready." }

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ confirmed?: string }>
}) {
  const user = await requireUser()
  const confirmed = (await searchParams).confirmed === "1"
  if (user.profile.onboardedAt) redirect("/home")
  // agents.rolePacks (A2): the use case's team instead of one first agent
  if ((await getSetting("agents.rolePacks")) === "on") {
    const [plan, memoryV2] = await Promise.all([
      getPlan(user.id),
      getSetting("agents.memoryV2"),
    ])
    return (
      <AuthCard
        title="Welcome to Kriya"
        subtitle="Tell us a little, then meet your team. You can change everything later."
      >
        {confirmed && <StateNotice state={CONFIRMED} />}
        <TeamOnboarding
          profile={user.profile}
          maxAgents={plan.maxAgents}
          askAbout={memoryV2 === "on"}
        />
      </AuthCard>
    )
  }
  return (
    <AuthCard
      title="Welcome to Kriya"
      subtitle="Two quick questions, and we'll set up your first agent. You can change everything later."
    >
      {confirmed && <StateNotice state={CONFIRMED} />}
      <OnboardingForm profile={user.profile} />
    </AuthCard>
  )
}
