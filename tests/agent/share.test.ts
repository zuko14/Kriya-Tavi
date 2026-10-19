import fs from "node:fs"
import path from "node:path"

import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { PERSON_ONLY_WRITES, TOOL_CLASSES, TOOL_WRITES } from "@/lib/agent/policy"
import type { BrowserProvider } from "@/lib/browser/provider"
import { setBrowserProviderForTests } from "@/lib/browser/session"
import { objectPath, setFileStoreForTests, type FileStore } from "@/lib/files"
import {
  createShare,
  listShares,
  openShare,
  purgeExpired,
  recordView,
  revokeShare,
  snapshotUrl,
  tokenHash,
} from "@/lib/share"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Kriya Share (K8): AT-SHR-01 expired or revoked → nothing, without
// detail; AT-SHR-02 the token is stored only as its sha256; AT-SHR-03 the
// snapshot doesn't follow the source; AT-SHR-04 no agent tool can create a
// share. The renderer and storage are in memory.

let pg: TestDb
let alice: string
let bob: string
let objects: Map<string, Buffer>
let rendered: string[]

const store = (): FileStore => ({
  uploadUrl: async (p) => `https://storage.test/upload/${p}`,
  read: async (p) => objects.get(p) ?? null,
  write: async (p, bytes) => void objects.set(p, bytes),
  signedUrl: async (p, seconds) => `https://storage.test/${p}?expires=${seconds}`,
  remove: async (paths) => paths.forEach((p) => objects.delete(p)),
})

const renderer = {
  renderPdf: async (html: string) => {
    rendered.push(html)
    return Buffer.from(`%PDF-1.4\n% ${rendered.length}\n%%EOF\n`)
  },
} as unknown as BrowserProvider

async function episode(user: string, tag: string) {
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'A', 'r', 'g')",
    [`a-${tag}`, user]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ($1, $2, $3)",
    [`t-${tag}`, user, `a-${tag}`]
  )
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.episodes (user_id, thread_id, done, seq, hash)
     values ($1, $2, $3, 1, $4) returning id`,
    [
      user,
      `t-${tag}`,
      JSON.stringify([
        {
          executionId: "x1",
          tool: "calendar_create_event",
          title: "Added “GATE mock test” to your calendar",
          risk: "R3",
          verification: {
            status: "verified",
            method: "api_readback",
            evidence: [{ kind: "provider_id", value: "evt_123456" }],
          },
        },
      ]),
      "a".repeat(64),
    ]
  )
  return rows[0].id
}

const tokenOf = (sharePath: string) => sharePath.split("/").pop()!

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  objects = new Map()
  rendered = []
  setFileStoreForTests(store())
  setBrowserProviderForTests(renderer)
})

afterEach(() => {
  setFileStoreForTests(undefined)
  setBrowserProviderForTests(null)
})

describe("creating a share", () => {
  it("renders a snapshot PDF and returns the link once", async () => {
    const ep = await episode(alice, "1")
    const result = await createShare(alice, { kind: "receipt", ref: ep, days: 7 })
    if (!result.path) throw new Error(result.error)
    expect(result.path).toMatch(/^\/share\/[A-Za-z0-9_-]{43}$/)
    expect(rendered[0]).toContain("Kriya Receipt #1")
    expect(rendered[0]).toContain("Added “GATE mock test” to your calendar")
    expect(objects.size).toBe(1)
    expect(await listShares(alice)).toEqual([
      expect.objectContaining({ title: "Kriya Receipt #1", views: 0, revokedAt: null }),
    ])
    // The listing never carries the token or its hash
    expect(JSON.stringify(await listShares(alice))).not.toContain(tokenOf(result.path))
  })

  it("can't share someone else's record", async () => {
    const ep = await episode(alice, "2")
    expect(await createShare(bob, { kind: "receipt", ref: ep, days: 7 })).toEqual({
      error: "That record wasn't found.",
    })
    expect(rendered).toEqual([])
  })

  it("at the plan's limit, says so and leaves no snapshot behind", async () => {
    const ep = await episode(alice, "3")
    for (let i = 0; i < 5; i++)
      await createShare(alice, { kind: "receipt", ref: ep, days: 1 })
    expect(objects.size).toBe(5)
    expect(await createShare(alice, { kind: "receipt", ref: ep, days: 1 })).toEqual({
      error: "You have as many live links as your plan allows. Revoke one first.",
    })
    expect(objects.size).toBe(5)
  })
})

describe("AT-SHR-01 expired or revoked links show nothing", () => {
  it("a live link opens; revoked, expired and unknown ones look the same", async () => {
    const ep = await episode(alice, "4")
    const live = await createShare(alice, { kind: "receipt", ref: ep, days: 7 })
    const token = tokenOf((live as { path: string }).path)
    expect(await openShare(token)).toMatchObject({ title: "Kriya Receipt #1" })

    expect(await revokeShare(bob, (live as { share: { id: string } }).share.id)).toBe(
      false
    )
    expect(await revokeShare(alice, (live as { share: { id: string } }).share.id)).toBe(
      true
    )
    expect(await openShare(token)).toBeNull()

    const other = await createShare(alice, { kind: "receipt", ref: ep, days: 1 })
    const otherToken = tokenOf((other as { path: string }).path)
    await pg.query(
      "update kriya.share_links set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where token_hash = $1",
      [tokenHash(otherToken)]
    )
    expect(await openShare(otherToken)).toBeNull()
    expect(await openShare("x".repeat(43))).toBeNull()
    expect(await openShare("../../etc")).toBeNull()
  })
})

describe("AT-SHR-02 the token is stored only hashed", () => {
  it("no column anywhere holds the token itself", async () => {
    const ep = await episode(alice, "5")
    const result = await createShare(alice, { kind: "receipt", ref: ep, days: 7 })
    const token = tokenOf((result as { path: string }).path)
    const { rows } = await pg.query("select * from kriya.share_links")
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows[0]).toMatchObject({ token_hash: tokenHash(token) })
  })
})

describe("AT-SHR-03 the snapshot doesn't follow the source", () => {
  it("deleting the record after sharing leaves the shared PDF as it was", async () => {
    const ep = await episode(alice, "6")
    const result = await createShare(alice, { kind: "receipt", ref: ep, days: 7 })
    const share = (await openShare(tokenOf((result as { path: string }).path)))!
    const file = (
      await pg.query<{ id: string; user_id: string }>(
        "select id, user_id from kriya.files where id = $1",
        [share.snapshotFileId]
      )
    ).rows[0]
    const before = objects.get(objectPath({ userId: file.user_id, id: file.id }))
    // The person's delete clears the record's content
    await pg.query(
      "update kriya.episodes set deleted_at = now(), done = '[]', unconfirmed = '[]', checks = '[]', titles = null, summary = null where id = $1",
      [ep]
    )
    expect(objects.get(objectPath({ userId: file.user_id, id: file.id }))).toEqual(before)
    expect(await snapshotUrl(share)).toContain(`${alice}/${file.id}`)
    expect(rendered).toHaveLength(1)
  })
})

describe("AT-SHR-04 no agent tool can create a share", () => {
  it("no tool writes share_links, and none is named for sharing", () => {
    expect(PERSON_ONLY_WRITES).toContain("share_links")
    for (const [tool, writes] of Object.entries(TOOL_WRITES)) {
      expect(
        writes.filter((w) => w.startsWith("share_")),
        tool
      ).toEqual([])
    }
    expect(Object.keys(TOOL_CLASSES).filter((name) => /share/.test(name))).toEqual([])
  })

  it("lib/agent/tools.ts doesn't import the share module", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "lib/agent/tools.ts"), "utf8")
    expect(source).not.toMatch(/@\/lib\/share|share_links|shareLinks/)
  })
})

describe("views and retention", () => {
  it("logs a view with an HMAC of the address, never the address", async () => {
    process.env.KRIYA_TOKEN_KEY = "test-key-for-hmac"
    const ep = await episode(alice, "7")
    const result = await createShare(alice, { kind: "receipt", ref: ep, days: 7 })
    const share = (await openShare(tokenOf((result as { path: string }).path)))!
    await recordView(share, "203.0.113.7")
    const { rows } = await pg.query<{ ip_hash: string }>(
      "select ip_hash from kriya.share_views"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7")
    expect((await listShares(alice))[0].views).toBe(1)
    delete process.env.KRIYA_TOKEN_KEY
  })

  it("deletes a snapshot 7 days after its share ended, and old screenshots", async () => {
    const ep = await episode(alice, "8")
    await createShare(alice, { kind: "receipt", ref: ep, days: 7 })
    const keep = await createShare(alice, { kind: "receipt", ref: ep, days: 7 })
    await pg.query(
      "update kriya.share_links set created_at = now() - interval '20 days', expires_at = now() - interval '8 days' where id <> $1",
      [(keep as { share: { id: string } }).share.id]
    )
    expect(await purgeExpired()).toBe(1)
    expect(objects.size).toBe(1)
    const { rows } = await pg.query("select id from kriya.share_links")
    expect(rows).toEqual([{ id: (keep as { share: { id: string } }).share.id }])
  })
})
