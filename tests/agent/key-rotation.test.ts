import { createCipheriv, randomBytes } from "node:crypto"

import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { profileForTask, profileJanitor, sealState } from "@/lib/browser/profiles"
import type { StorageState } from "@/lib/browser/provider"
import { keyId, needsReseal, open, seal, sealedKeyId } from "@/lib/secrets"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Key rotation for sealed values (SECURITY_AND_COMPLIANCE §5, GA-5): the
// code half of the drill in docs/agent-platform/runbooks/key-rotation.md.
// New values name their key; old ones still open with the key being
// retired; saved logins move to the new key; a retired key opens nothing.

const A = randomBytes(32).toString("base64")
const B = randomBytes(32).toString("base64")
const use = (current: string, previous?: string) => {
  process.env.KRIYA_TOKEN_KEY = current
  if (previous) process.env.KRIYA_TOKEN_KEY_PREVIOUS = previous
  else delete process.env.KRIYA_TOKEN_KEY_PREVIOUS
}

// What lib/secrets.ts wrote before key ids (format v1)
function legacySeal(plaintext: string, context: string, key: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return ["v1", iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".")
}

afterEach(() => use(A))

describe("sealed values across a key rotation", () => {
  it("new values name their key by a short id that isn't the key", () => {
    use(A)
    const sealed = seal("ya29.token", "u:google")
    expect(sealed.split(".")).toHaveLength(4)
    expect(sealedKeyId(sealed)).toBe(keyId())
    expect(keyId()).toMatch(/^[0-9a-f]{8}$/)
    expect(sealed).not.toContain(A)
    expect(needsReseal(sealed)).toBe(false)
  })

  it("v1 values from before still open", () => {
    use(A)
    const old = legacySeal("ya29.token", "u:google", A)
    expect(sealedKeyId(old)).toBe("v1")
    expect(open(old, "u:google")).toBe("ya29.token")
    expect(needsReseal(old)).toBe(true)
  })

  it("rotation: old values open with the previous key, new ones use the new key, and a retired key opens nothing", () => {
    use(A)
    const before = seal("ya29.token", "u:google")
    const legacy = legacySeal("refresh", "u:google", A)
    use(B, A)
    expect(open(before, "u:google")).toBe("ya29.token")
    expect(open(legacy, "u:google")).toBe("refresh")
    expect(needsReseal(before)).toBe(true)
    const after = seal(open(before, "u:google"), "u:google")
    expect(needsReseal(after)).toBe(false)
    // Context binding still holds with either key
    expect(() => open(before, "someone-else:google")).toThrow()
    use(B)
    expect(open(after, "u:google")).toBe("ya29.token")
    expect(() => open(before, "u:google")).toThrow(/retired/)
    expect(() => open(legacy, "u:google")).toThrow()
  })

  it("refuses a malformed previous key", () => {
    use(B, "too-short")
    const sealed = legacySeal("x", "u:google", A)
    expect(() => open(sealed, "u:google")).toThrow(
      /KRIYA_TOKEN_KEY_PREVIOUS must be 32 bytes/
    )
  })
})

describe("saved logins move to the new key", () => {
  let pg: TestDb
  let user: string
  const STATE: StorageState = {
    cookies: [
      {
        name: "session",
        value: "fixture",
        domain: "fixture.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  }

  async function saved(label: string) {
    const { rows } = await pg.query<{ id: string }>(
      "insert into kriya.login_profiles (user_id, domain, label) values ($1, 'fixture.test', $2) returning id",
      [user, label]
    )
    await pg.query(
      "update kriya.login_profiles set status = 'active', state_sealed = $2, confirmed_at = now(), expires_at = now() + interval '90 days' where id = $1",
      [rows[0].id, sealState(user, rows[0].id, STATE)]
    )
    return rows[0].id
  }
  const sealedOf = async (id: string) =>
    (
      await pg.query<{ state_sealed: string | null; status: string }>(
        "select state_sealed, status from kriya.login_profiles where id = $1",
        [id]
      )
    ).rows[0]

  beforeEach(async () => {
    pg = await createTestDb()
    setDatabaseForTests(
      drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
    )
    await pg.query("update kriya.plans set max_login_profiles = 5 where id = 'free'")
    user = await createUser(pg)
  })

  it("the janitor re-seals them during a rotation, and nothing is lost when the old key goes", async () => {
    use(A)
    const one = await saved("one")
    const two = await saved("two")
    use(B, A)
    expect(await profileJanitor()).toMatchObject({ resealed: 2 })
    for (const id of [one, two]) {
      expect(needsReseal((await sealedOf(id)).state_sealed!)).toBe(false)
    }
    use(B)
    expect((await profileForTask({ userId: user }, "fixture.test"))?.state).toEqual(STATE)
  })

  it("a login used during the rotation is re-sealed on use", async () => {
    use(A)
    const id = await saved("used")
    use(B, A)
    await profileForTask({ userId: user }, "fixture.test")
    expect(needsReseal((await sealedOf(id)).state_sealed!)).toBe(false)
  })

  it("one that opens with neither key is expired (the person signs in again)", async () => {
    use(randomBytes(32).toString("base64"))
    const lost = await saved("lost")
    use(B, A)
    await profileJanitor()
    expect(await sealedOf(lost)).toEqual({ state_sealed: null, status: "expired" })
  })

  it("without a rotation under way, the janitor re-seals nothing", async () => {
    use(A)
    await saved("steady")
    expect(await profileJanitor()).toMatchObject({ resealed: 0 })
  })
})
