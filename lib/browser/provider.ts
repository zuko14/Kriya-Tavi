import type {
  ActionResult,
  BrowserAction,
  OpenSession,
  PdfOptions,
  Snapshot,
  StorageState,
} from "@/browser/protocol"

export type * from "@/browser/protocol"

// How the worker drives a browser (AD-08). kriya-browser over HTTPS is the
// one implementation (client.ts); a managed vendor would be a second one.
export interface BrowserProvider {
  open(input: OpenSession): Promise<{ sessionId: string }>
  act(sessionId: string, action: BrowserAction): Promise<ActionResult>
  snapshot(sessionId: string): Promise<Snapshot>
  heartbeat(sessionId: string): Promise<boolean>
  // captureState: the session's storage state, for a login profile (A6)
  close(
    sessionId: string,
    captureState?: boolean
  ): Promise<{ seconds: number; state?: StorageState }>
  renderPdf(html: string, options?: PdfOptions): Promise<Buffer>
}
