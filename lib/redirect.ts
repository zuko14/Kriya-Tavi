// Where to send someone after sign-in or an email link: a same-site path
// only. Parsed rather than prefix-checked, because browsers strip tabs and
// newlines and treat "\" like "/", so "/\t/evil.com" would become
// "//evil.com". Re-serialized from the parsed URL so what we check is what
// the browser gets.
const BASE = "http://kriya.invalid"

export function safeNext(value: string | null | undefined, fallback = "/home") {
  if (!value || !value.startsWith("/") || /[\u0000-\u001F\u007F\\]/.test(value)) {
    return fallback
  }
  try {
    const url = new URL(value, BASE)
    if (url.origin !== BASE || url.pathname.startsWith("//")) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}
