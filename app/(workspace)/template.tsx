import { ViewTransition } from "react"

// A template remounts on every navigation (a layout doesn't), so each
// workspace page lifts away and the next settles in (app/globals.css,
// page-in / page-out). Refreshes and streaming updates don't animate.
export default function WorkspaceTemplate({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="page-in" exit="page-out" default="none">
      {children}
    </ViewTransition>
  )
}
