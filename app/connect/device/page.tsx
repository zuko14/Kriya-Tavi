import type { Metadata } from "next"
import { formatDistanceToNowStrict } from "date-fns"
import { notFound } from "next/navigation"

import { AuthCard, Notice } from "@/components/auth/auth-kit"
import { ConnectDevice } from "@/components/harness/connect-device"
import { Button } from "@/components/ui/button"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { codeView } from "@/lib/harness/devices"
import { agentChoices } from "@/queries/harness"

export const metadata: Metadata = { title: "Connect a device" }

// Signing in Kriya Harness on a computer (HD-05, UX_SPEC §1): the terminal
// shows a code; the person compares it here, picks the agent the device
// works as, and approves or denies. proxy.ts sends a signed-out visitor to
// sign in and back here with the code.

const PLATFORMS = { darwin: "macOS", linux: "Linux", win32: "Windows" } as const

const STATES = {
  used: "This code was already used. Run kriya login again if you need a new one.",
  denied: "This sign-in was denied. Run kriya login again to start over.",
  expired: "This code has expired. Run kriya login again for a new one.",
} as const

function CodeForm({ code }: { code?: string }) {
  return (
    <form method="get" className="flex flex-col gap-2 sm:flex-row">
      <input
        name="code"
        defaultValue={code}
        required
        autoComplete="off"
        autoCapitalize="characters"
        aria-label="Code from your terminal"
        placeholder="ABCD-2345"
        className="min-h-11 flex-1 rounded-md border bg-transparent px-3 font-mono text-[15px] tracking-widest uppercase"
      />
      <Button type="submit" className="min-h-11">
        Continue
      </Button>
    </form>
  )
}

export default async function ConnectDevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const user = await requireUser()
  if ((await getSetting("harness.api")) !== "on") notFound()
  const { code } = await searchParams
  const view = code ? await codeView(code) : null

  if (!view)
    return (
      <AuthCard
        title="Connect a device"
        subtitle="Enter the code Kriya Harness shows in your terminal."
      >
        <div className="flex flex-col gap-4">
          {code && (
            <Notice tone="error">
              That code wasn&apos;t found. Check it in your terminal.
            </Notice>
          )}
          <CodeForm code={code} />
        </div>
      </AuthCard>
    )

  if (view.state !== "open")
    return (
      <AuthCard title="Connect a device">
        <Notice tone="error">{STATES[view.state]}</Notice>
      </AuthCard>
    )

  return (
    <AuthCard
      title={`Sign in Kriya Harness on ${view.deviceName} (${PLATFORMS[view.platform]})?`}
      subtitle={`Requested ${formatDistanceToNowStrict(view.createdAt, { addSuffix: true })}. Only approve if you just ran kriya login.`}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1 rounded-lg border px-4 py-3">
          <span className="label-mono">code in your terminal</span>
          <span className="font-mono text-[22px] tracking-[0.2em]">{view.code}</span>
        </div>
        <ConnectDevice code={view.code} agents={await agentChoices(user.id)} />
      </div>
    </AuthCard>
  )
}
