// A request's JSON body, read with a hard size cap. Content-Length can be
// missing (chunked uploads), so the bytes are counted as they arrive and the
// read stops at the cap instead of buffering whatever is sent.
export async function readJson(request: Request, maxBytes: number) {
  const reader = request.body?.getReader()
  if (!reader) return { ok: false as const, tooLarge: false }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return { ok: false as const, tooLarge: true }
    }
    chunks.push(value)
  }
  try {
    const text = new TextDecoder().decode(Buffer.concat(chunks))
    return { ok: true as const, body: JSON.parse(text) as unknown }
  } catch {
    return { ok: false as const, tooLarge: false }
  }
}
