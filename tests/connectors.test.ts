import { randomBytes } from "node:crypto"

import { beforeAll, describe, expect, it } from "vitest"

import { privateContentSeen } from "@/lib/agent/tools"
import { draftMime, googleServices, GOOGLE_SERVICES } from "@/lib/connectors"
import { open, seal } from "@/lib/secrets"

beforeAll(() => {
  process.env.KRIYA_TOKEN_KEY = randomBytes(32).toString("base64")
})

describe("sealed tokens", () => {
  it("opens what it sealed, for the same owner only", () => {
    const sealed = seal("ya29.secret-token", "user-a:google")
    expect(sealed).not.toContain("secret")
    expect(open(sealed, "user-a:google")).toBe("ya29.secret-token")
    // Copied onto someone else's row, it doesn't open
    expect(() => open(sealed, "user-b:google")).toThrow()
  })

  it("refuses a tampered value", () => {
    const [v, iv, tag, body] = seal("token", "u:google").split(".")
    const flipped = Buffer.from(body, "base64url")
    flipped[0] ^= 1
    expect(() =>
      open([v, iv, tag, flipped.toString("base64url")].join("."), "u:google")
    ).toThrow()
  })

  it("refuses to work without a proper key", () => {
    const key = process.env.KRIYA_TOKEN_KEY
    process.env.KRIYA_TOKEN_KEY = "too-short"
    expect(() => seal("x", "u:google")).toThrow(/32 bytes/)
    process.env.KRIYA_TOKEN_KEY = key
  })
})

describe("gmail drafts", () => {
  it("keeps headers on one line so a subject can't add recipients", () => {
    const mime = draftMime({
      to: ["a@example.com"],
      subject: "Hi\r\nBcc: attacker@example.com",
      body: "Hello",
    })
    const headers = mime.split("\r\n\r\n")[0].split("\r\n")
    expect(headers.some((h) => h.startsWith("Bcc:"))).toBe(false)
    expect(headers).toContain("Subject: Hi Bcc: attacker@example.com")
  })

  it("encodes a non-English subject", () => {
    const mime = draftMime({ to: ["a@example.com"], subject: "नमस्ते", body: "x" })
    expect(mime).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("नमस्ते").toString("base64")}?=`
    )
  })
})

describe("google services", () => {
  it("switches a service on only when all its scopes were granted", () => {
    const scopes = [
      ...GOOGLE_SERVICES.calendar.scopes,
      GOOGLE_SERVICES.gmail.scopes[0], // read without compose
    ]
    expect(googleServices(scopes)).toEqual(["calendar"])
  })
})

describe("web requests after private reads", () => {
  const call = (toolName: string) => ({
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "c", toolName, input: {} }],
  })
  it("need approval once mail or documents are in the conversation", () => {
    expect(
      privateContentSeen([{ role: "user", content: "hi" }, call("web_search")])
    ).toBe(false)
    expect(privateContentSeen([call("gmail_read"), call("web_search")])).toBe(true)
  })
})
