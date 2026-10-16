"use client"

import * as React from "react"

import type { AgentTemplate } from "@/lib/templates"
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
  dialog: DialogState
  openAgentDialog: (options?: { agent?: NavAgent; template?: AgentTemplate }) => void
  openSquadDialog: (options?: { squad?: NavSquad }) => void
  openPalette: () => void
  closeDialog: () => void
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null)

export function useWorkspace() {
  const value = React.useContext(WorkspaceContext)
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>")
  return value
}

export function WorkspaceProvider({
  nav,
  status,
  children,
}: {
  nav: Navigation
  status: SystemStatus
  children: React.ReactNode
}) {
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)

  const value = React.useMemo<WorkspaceContextValue>(
    () => ({
      nav,
      status,
      dialog,
      openAgentDialog: (options) => setDialog({ kind: "agent", ...options }),
      openSquadDialog: (options) => setDialog({ kind: "squad", ...options }),
      openPalette: () => setDialog({ kind: "palette" }),
      closeDialog: () => setDialog(null),
      mobileNavOpen,
      setMobileNavOpen,
    }),
    [nav, status, dialog, mobileNavOpen]
  )

  return <WorkspaceContext value={value}>{children}</WorkspaceContext>
}
