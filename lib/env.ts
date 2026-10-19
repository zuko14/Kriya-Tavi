// Startup check of the environment. In production a missing required value
// stops the process with a list of what's missing (names only, never values);
// in development it's a warning. Optional values degrade a feature and are
// reported once.

type Check = { name: string; why: string; test?: (value: string) => string | null }

const notLocal = (value: string) =>
  /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(value) ? "points at a local address" : null
const https = (value: string) =>
  value.startsWith("https://") ? null : "must start with https://"

const REQUIRED: Record<"web" | "worker", Check[]> = {
  web: [
    { name: "DATABASE_URL", why: "Supabase Postgres connection", test: notLocal },
    { name: "NEXT_PUBLIC_SUPABASE_URL", why: "Supabase Auth", test: https },
    { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", why: "Supabase Auth" },
    {
      name: "KRIYA_APP_URL",
      why: "links in emails and redirect checks",
      test: (value) => https(value) ?? notLocal(value),
    },
  ],
  worker: [
    { name: "DATABASE_URL", why: "Supabase Postgres connection", test: notLocal },
    { name: "OPENROUTER_API_KEY", why: "model calls" },
  ],
}

const OPTIONAL: Record<"web" | "worker", Check[]> = {
  web: [
    {
      name: "OPENROUTER_API_KEY",
      why: "checking that models are reachable before queueing",
    },
    { name: "SUPABASE_SECRET_KEY", why: "account deletion and owner user lookup" },
    {
      name: "KRIYA_FX_USD_INR",
      why: "rupee charges (until set, charges are recorded as unpriced)",
    },
    {
      name: "RAZORPAY_WEBHOOK_SECRET",
      why: "paid plans (test-mode billing only without it)",
    },
    {
      name: "KRIYA_TOKEN_KEY",
      why: "connected accounts (32 random bytes, base64; encrypts their tokens)",
    },
    {
      name: "KRIYA_TOKEN_KEY_PREVIOUS",
      why: "only during a key rotation: the key being retired",
    },
    { name: "GOOGLE_CLIENT_ID", why: "connecting Google Calendar, Gmail and Drive" },
    { name: "GOOGLE_CLIENT_SECRET", why: "connecting Google Calendar, Gmail and Drive" },
    { name: "NOTION_CLIENT_ID", why: "connecting Notion" },
    { name: "NOTION_CLIENT_SECRET", why: "connecting Notion" },
    {
      name: "KRIYA_BROWSER_URL",
      why: "receipt PDFs and share snapshots (kriya-browser)",
    },
    {
      name: "KRIYA_BROWSER_SECRET",
      why: "receipt PDFs and share snapshots (kriya-browser)",
    },
    {
      name: "KRIYA_BROWSER_LIVE_URL",
      why: "take-over and saved logins (kriya-browser's public wss:// live view)",
    },
  ],
  worker: [
    {
      name: "OPENROUTER_DEFAULT_MODEL",
      why: "the budget tier (or set it in /owner/config)",
    },
    { name: "FIRECRAWL_API_KEY", why: "web search and reading pages" },
    {
      name: "KRIYA_TOKEN_KEY",
      why: "connected accounts (32 random bytes, base64; encrypts their tokens)",
    },
    {
      name: "KRIYA_TOKEN_KEY_PREVIOUS",
      why: "only during a key rotation: the key being retired",
    },
    { name: "GOOGLE_CLIENT_ID", why: "connecting Google Calendar, Gmail and Drive" },
    { name: "GOOGLE_CLIENT_SECRET", why: "connecting Google Calendar, Gmail and Drive" },
    { name: "NOTION_CLIENT_ID", why: "connecting Notion" },
    { name: "NOTION_CLIENT_SECRET", why: "connecting Notion" },
    {
      name: "KRIYA_FX_USD_INR",
      why: "rupee charges (until set, charges are recorded as unpriced)",
    },
    { name: "KRIYA_BROWSER_URL", why: "agent browser tools (kriya-browser)" },
    { name: "KRIYA_BROWSER_SECRET", why: "agent browser tools (kriya-browser)" },
    {
      name: "NEXT_PUBLIC_SUPABASE_URL",
      why: "reading uploaded files (kriya-files bucket)",
    },
    { name: "SUPABASE_SECRET_KEY", why: "reading uploaded files (kriya-files bucket)" },
  ],
}

export function checkEnvironment(service: "web" | "worker") {
  const production = process.env.NODE_ENV === "production"
  const problems = REQUIRED[service].flatMap(({ name, why, test }) => {
    const value = process.env[name]?.trim()
    if (!value) return [`${name} is missing (${why})`]
    const issue = production ? test?.(value) : null
    return issue ? [`${name} ${issue}`] : []
  })
  const missing = OPTIONAL[service]
    .filter(({ name }) => !process.env[name]?.trim())
    .map(({ name, why }) => `${name} not set: ${why}`)

  for (const line of missing) console.warn(`[kriya] ${line}`)
  if (problems.length === 0) return
  const message = `[kriya] ${service} configuration:\n  - ${problems.join("\n  - ")}`
  if (production) throw new Error(message)
  console.warn(message)
}
