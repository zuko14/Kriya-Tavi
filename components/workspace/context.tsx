"use client"

import * as React from "react"

import type { AgentTemplate } from "@/lib/templates"
import type { Features } from "@/queries/features"
import type { Navigation, NavAgent, NavSquad, SystemStatus } from "@/queries/workspace"

export { agentTemplates, type AgentTemplate } from "@/lib/templates"

type DialogState =
  | { kind: "agent"; agent?: NavAgent; template?: AgentTemplate }
  | { kind: "squad"; squad?: NavSquad }
  | { kind: "palette" }
  | null

type WorkspaceContextValue = {
  nav: Navigation
  status: SystemStatus
  features: Features
  // First-paint counts; the sidebar and tab bar refresh them on each page
  badges: Badges
  dialog: DialogState
  openAgentDialog: (options?: { agent?: NavAgent; template?: AgentTemplate }) => void
  openSquadDialog: (options?: { squad?: NavSquad }) => void
  openPalette: () => void
  closeDialog: () => void
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void
}

export type Badges = { inbox: number | null; rooms: number }

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null)

export function useWorkspace() {
  const value = React.useContext(WorkspaceContext)
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>")
  return value
}

export function WorkspaceProvider({
  nav,
  status,
  features,
  badges,
  children,
}: {
  nav: Navigation
  status: SystemStatus
  features: Features
  badges: Badges
  children: React.ReactNode
}) {
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)

  const value = React.useMemo<WorkspaceContextValue>(
    () => ({
      nav,
      status,
      features,
      badges,
      dialog,
      openAgentDialog: (options) => setDialog({ kind: "agent", ...options }),
      openSquadDialog: (options) => setDialog({ kind: "squad", ...options }),
      openPalette: () => setDialog({ kind: "palette" }),
      closeDialog: () => setDialog(null),
      mobileNavOpen,
      setMobileNavOpen,
    }),
    [nav, status, features, badges, dialog, mobileNavOpen]
  )

  return <WorkspaceContext value={value}>{children}</WorkspaceContext>
}
