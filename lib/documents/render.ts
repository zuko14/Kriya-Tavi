import { privileged } from "@/db"
import { resourceUsage } from "@/db/schema"
import { browserProvider } from "@/lib/browser/session"
import { saveGenerated } from "@/lib/files"

// HTML → PDF in kriya-browser (AD-18), saved as the person's generated
// file. kriya-browser renders with no network and no JavaScript.

export class PdfUnavailableError extends Error {
  constructor() {
    super("PDFs aren't available yet: the document renderer isn't set up.")
  }
}

export async function renderPdf(html: string) {
  const provider = browserProvider()
  if (!provider) throw new PdfUnavailableError()
  return provider.renderPdf(html, { format: "A4" })
}

// Renders and stores; the render is metered (unpriced) in resource_usage
export async function savePdf(
  userId: string,
  input: { html: string; name: string; taskId?: string | null }
) {
  const bytes = await renderPdf(input.html)
  const file = await saveGenerated(userId, {
    name: input.name.endsWith(".pdf") ? input.name : `${input.name}.pdf`,
    mime: "application/pdf",
    bytes,
    origin: "generated",
    taskId: input.taskId,
  })
  await privileged
    .insert(resourceUsage)
    .values({
      requestKey: `pdf:${file.id}`,
      userId,
      taskId: input.taskId ?? null,
      kind: "pdf_render",
      quantity: 1,
      costMicroUsd: null,
    })
    .onConflictDoNothing()
  return file
}
