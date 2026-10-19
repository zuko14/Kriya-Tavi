// Lite mode (K10, AD-36): less traffic on slow networks and cheap phones.
// No imports: client components and the server both use this.

// The browser's request header for the slower thread stream
export const LITE_HEADER = "x-kriya-lite"

// The person's explicit choice wins; until they make one, Lite mode follows
// the browser's save-data hint (navigator.connection.saveData)
export function liteMode(chosen: boolean | null, saveData: boolean | undefined) {
  return chosen ?? saveData === true
}

type Page = {
  visibilityState: string
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

// Keeps a live connection (the notifications EventSource) open, except in
// Lite mode while the page is hidden: closed then, reopened when it's shown.
// Returns the cleanup.
export function followWhileVisible(
  open: () => { close(): void },
  lite: boolean,
  page: Page
) {
  let source = !lite || page.visibilityState !== "hidden" ? open() : null
  if (!lite) return () => source?.close()
  const onChange = () => {
    if (page.visibilityState === "hidden") {
      source?.close()
      source = null
    } else source ??= open()
  }
  page.addEventListener("visibilitychange", onChange)
  return () => {
    page.removeEventListener("visibilitychange", onChange)
    source?.close()
  }
}
