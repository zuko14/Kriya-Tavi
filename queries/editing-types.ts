// Shared with the client's cards, which must not import queries/editing.ts (it loads db)
export type EditCard = {
  id: string
  kind: string
  prompt: string
  jobId: string | null
  expiresAt: Date
  options: unknown
  defaultOption: number | null
  deviceName: string
}
