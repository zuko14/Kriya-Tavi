import type {
  ActionResult,
  BrowserAction,
  BrowserProvider,
  PageElement,
  Snapshot,
} from "@/lib/browser/provider"

// A scripted kriya-browser over fixture pages by URL (AD-23: no real site)

export const el = (ref: string, over: Partial<PageElement>): PageElement => ({
  ref,
  role: "link",
  name: "",
  inForm: false,
  sensitive: false,
  ...over,
})

export class FixtureBrowser implements BrowserProvider {
  calls: string[] = []
  url = "about:blank"
  pages: Record<string, { title: string; elements: PageElement[] }> = {}
  snap(): Snapshot {
    const page = this.pages[this.url] ?? { title: "Blank", elements: [] }
    return {
      title: page.title,
      elements: page.elements,
      text: `Text of ${page.title}`,
      diff: null,
      facts: {
        url: this.url,
        domain: "example.test",
        hasForm: false,
        focusedSensitive: false,
        captcha: false,
      },
    }
  }
  async open() {
    return { sessionId: "6f1c3c1e-0000-4000-8000-000000000001" }
  }
  async act(_id: string, action: BrowserAction): Promise<ActionResult> {
    this.calls.push(action.action === "open" ? `open ${action.url}` : action.action)
    if (action.action === "open") this.url = action.url
    if (action.action === "click") {
      const link = this.snap().elements.find((e) => e.ref === action.ref)
      if (link?.href) this.url = link.href
    }
    return { ok: true, snapshot: this.snap() }
  }
  async snapshot() {
    return this.snap()
  }
  async heartbeat() {
    return true
  }
  async close() {
    return { seconds: 1 }
  }
  async renderPdf() {
    return Buffer.from("%PDF-")
  }
}
