import { redirect } from "next/navigation"

import { AgentDialog } from "@/components/dialogs/agent-dialog"
import { SquadDialog } from "@/components/dialogs/squad-dialog"
import { BottomNav } from "@/components/workspace/bottom-nav"
import { CommandPalette } from "@/components/workspace/command-palette"
import { WorkspaceProvider } from "@/components/workspace/context"
import { MobileNav } from "@/components/workspace/mobile-nav"
import { NotificationsProvider } from "@/components/workspace/notifier"
import { Sidebar } from "@/components/workspace/sidebar"
import { StatusBar } from "@/components/workspace/status-bar"
import { requireUser } from "@/lib/auth"
import { getNavigation, getSystemStatus } from "@/queries/workspace"

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await requireUser()
  if (!user.profile.onboardedAt) redirect("/onboarding")
  const [nav, status] = await Promise.all([getNavigation(user.id), getSystemStatus(user)])

  return (
    <WorkspaceProvider nav={nav} status={status}>
      <NotificationsProvider>
        {/* Pinned to the viewport: the page itself never scrolls, only the panes */}
        <div className="aura fixed inset-0 flex flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="hidden w-[264px] shrink-0 border-r bg-background/40 backdrop-blur-2xl md:flex">
              <Sidebar />
            </div>
            <main className="flex min-w-0 flex-1 flex-col">
              <MobileNav />
              {children}
            </main>
          </div>
          <StatusBar />
          <BottomNav />
        </div>
        <CommandPalette />
        <AgentDialog />
        <SquadDialog />
      </NotificationsProvider>
    </WorkspaceProvider>
  )
}
