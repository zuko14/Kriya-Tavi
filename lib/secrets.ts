import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

// Encryption for the few per-person secrets that can't live in the
// environment: the OAuth tokens of connected accounts. AES-256-GCM with a key
// from KRIYA_TOKEN_KEY (32 random bytes, base64), so the database holds only
// ciphertext. Each value is bound to what it belongs to (`context`, e.g.
// "<user id>:google"), so a ciphertext moved to another row won't decrypt.
//
// Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const VERSION = "v1"

export class SecretsConfigError extends Error {
  name = "SecretsConfigError"
}

function key() {
  const raw = process.env.KRIYA_TOKEN_KEY?.trim()
  if (!raw) throw new SecretsConfigError("KRIYA_TOKEN_KEY is not set.")
  const bytes = Buffer.from(raw, "base64")
  if (bytes.length !== 32) {
    throw new SecretsConfigError("KRIYA_TOKEN_KEY must be 32 bytes, base64-encoded.")
  }
  return bytes
}

export function isSecretsConfigured() {
  try {
    key()
    return true
  } catch {
    return false
  }
}

export function seal(plaintext: string, context: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".")
}

export function open(sealed: string, context: string) {
  const [version, iv, tag, body] = sealed.split(".")
  if (version !== VERSION || !iv || !tag || body === undefined) {
    throw new Error("Not a sealed value.")
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
