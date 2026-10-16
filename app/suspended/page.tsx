import type { Metadata } from "next"

import { signOut } from "@/actions/auth"
import { AuthCard } from "@/components/auth/auth-kit"
import { getSetting } from "@/lib/config"

export const metadata: Metadata = { title: "Account paused" }

export default async function SuspendedPage() {
  const support = await getSetting("support.email")
  return (
    <AuthCard
      title="Your account is paused"
      subtitle="Access to this account has been paused. Your data is safe and nothing has been deleted."
    >
      <div className="flex flex-col gap-4 text-[13px] text-muted-foreground">
        <p>
          If you think this is a mistake,{" "}
          {support ? (
            <a href={`mailto:${support}`} className="text-rigel hover:underline">
              write to {support}
            </a>
          ) : (
            "contact Kriya support"
          )}{" "}
          from the email address on the account.
        </p>
        <form action={signOut}>
          <button type="submit" className="text-rigel hover:underline">
            Sign out
          </button>
        </form>
      </div>
    </AuthCard>
  )
}
