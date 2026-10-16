import type { NextConfig } from "next"

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // The microphone is for dictation in the composer; nothing else is used
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)",
  },
  // shortcut: no script-src policy yet (Next's inline bootstrap needs nonces);
  // add a nonce-based CSP before handling payments in-page
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
]

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // Server action arguments can contain passwords; keep them out of the terminal
  logging: { serverFunctions: false },
  agentRules: false,
  serverExternalPackages: ["postgres"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

export default nextConfig
