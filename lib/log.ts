// Structured, redacted logs: one JSON object per line, which Render's log
// stream (and any drain attached to it) can search. Message content, keys,
// tokens and cookies never go in; errors keep their name and message only.

type Fields = Record<string, unknown>

const SECRET_KEY =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|signature|storage[-_]?state|(local|session)[-_]?storage|sealed/i
const SECRET_VALUE =
  /(sk-[a-z0-9-]{8,}|sb_secret_[a-z0-9_-]{8,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+|rzp_(live|test)_[a-z0-9]{8,}|v(1|2_[0-9a-f]{8})\.[\w-]{16}\.[\w-]{22}\.[\w-]+)/gi
// Cookie and Set-Cookie header lines inside a string
const COOKIE_HEADER = /\b(set-cookie|cookie):[^\r\n]*/gi
// A browser storage state (login profile) serialised into a string
const STORAGE_STATE = /"(cookies|origins|localStorage)"\s*:\s*\[/

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: clean(value.message, depth + 1) }
  }
  if (typeof value === "string") {
    if (STORAGE_STATE.test(value)) return "[redacted]"
    const text = value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value
    return text
      .replace(SECRET_VALUE, "[redacted]")
      .replace(COOKIE_HEADER, "$1: [redacted]")
  }
  if (value && typeof value === "object" && depth < 4) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : clean(inner, depth + 1),
      ])
    )
  }
  return value
}

function write(level: "info" | "warn" | "error", message: string, fields?: Fields) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: process.env.KRIYA_SERVICE ?? "web",
    message,
    ...(fields ? (clean(fields) as Fields) : {}),
  })
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

export const log = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
}

export const __test = { clean }
