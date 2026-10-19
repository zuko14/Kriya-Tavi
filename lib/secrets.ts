import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

// Encryption for the few per-person secrets that can't live in the
// environment: the OAuth tokens of connected accounts and the login profiles
// of the agent browser (invariant 4). AES-256-GCM with a key
// from KRIYA_TOKEN_KEY (32 random bytes, base64), so the database holds only
// ciphertext. Each value is bound to what it belongs to (`context`, e.g.
// "<user id>:google"), so a ciphertext moved to another row won't decrypt.
//
// Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Rotation (docs/agent-platform/runbooks/key-rotation.md): set the new key as
// KRIYA_TOKEN_KEY and the old one as KRIYA_TOKEN_KEY_PREVIOUS; values are
// sealed again with the new key as they're used, then the old one goes.

// v1: the first format, without saying which key sealed it. v2_<id>: the
// same, with the key's short id, so rotation can count what's left on an
// old key without opening anything (SECURITY_AND_COMPLIANCE §5, GA-5).
const LEGACY = "v1"
const VERSION = "v2"

export class SecretsConfigError extends Error {
  name = "SecretsConfigError"
}

function decode(name: string, raw: string) {
  const bytes = Buffer.from(raw, "base64")
  if (bytes.length !== 32) {
    throw new SecretsConfigError(`${name} must be 32 bytes, base64-encoded.`)
  }
  return bytes
}

function key() {
  const raw = process.env.KRIYA_TOKEN_KEY?.trim()
  if (!raw) throw new SecretsConfigError("KRIYA_TOKEN_KEY is not set.")
  return decode("KRIYA_TOKEN_KEY", raw)
}

// During a rotation only: the key being retired. Values sealed with it still
// open; nothing new is sealed with it.
function previousKey() {
  const raw = process.env.KRIYA_TOKEN_KEY_PREVIOUS?.trim()
  return raw ? decode("KRIYA_TOKEN_KEY_PREVIOUS", raw) : null
}

// A short public fingerprint of a key, never the key
export function keyId(bytes: Buffer = key()) {
  return createHash("sha256")
    .update("kriya-key-id")
    .update(bytes)
    .digest("hex")
    .slice(0, 8)
}

// Which key sealed a value: its id, or "v1" when the value doesn't say
export function sealedKeyId(sealed: string) {
  const version = sealed.split(".")[0]
  return version.startsWith(`${VERSION}_`) ? version.slice(VERSION.length + 1) : LEGACY
}

// True when a value should be sealed again with the current key
export function needsReseal(sealed: string) {
  return sealedKeyId(sealed) !== keyId()
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
  const current = key()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", current, iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [`${VERSION}_${keyId(current)}`, iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".")
}

function decrypt(bytes: Buffer, iv: string, tag: string, body: string, context: string) {
  const decipher = createDecipheriv("aes-256-gcm", bytes, Buffer.from(iv, "base64url"))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}

export function open(sealed: string, context: string) {
  const [version, iv, tag, body] = sealed.split(".")
  if (
    !(version === LEGACY || /^v2_[0-9a-f]{8}$/.test(version ?? "")) ||
    !iv ||
    !tag ||
    body === undefined
  ) {
    throw new Error("Not a sealed value.")
  }
  const previous = previousKey()
  const keys = previous ? [key(), previous] : [key()]
  // A v2 value names its key; a v1 value is tried with each (GCM refuses a
  // wrong key, so trying is safe)
  const id = sealedKeyId(sealed)
  const candidates = id === LEGACY ? keys : keys.filter((k) => keyId(k) === id)
  if (candidates.length === 0) {
    throw new SecretsConfigError("This value was sealed with a key that's been retired.")
  }
  let failure: unknown
  for (const candidate of candidates) {
    try {
      return decrypt(candidate, iv, tag, body, context)
    } catch (error) {
      failure = error
    }
  }
  throw failure
}
