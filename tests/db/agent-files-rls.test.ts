import { createHash, randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20261110000000_files.sql (AT-RLS-A for files, share_links, share_views):
// each person sees and changes only their own rows; a share's token hash
// isn't readable by any session; uploads start pending and only the server
// moves them on; plan limits hold in SQL (invariant 7).

let pg: TestDb
let alice: string
let bob: string

const MB = 1048576
const hash = (s: string) => createHash("sha256").update(s).digest("hex")

const upload = (user: string, size = 1000, name = "notes.txt") =>
  asUser(pg, user, (tx) =>
    tx.query<{ id: string }>(
      "insert into kriya.files (user_id, name, mime, size_bytes, origin) values ($1, $2, 'text/plain', $3, 'upload') returning id",
      [user, name, size]
    )
  ).then((r) => r.rows[0].id)

// The server's side (privileged): a generated file
const generated = async (user: string) =>
  (
    await pg.query<{ id: string }>(
      "insert into kriya.files (user_id, name, mime, size_bytes, origin) values ($1, 'receipt.pdf', 'application/pdf', 2000, 'generated') returning id",
      [user]
    )
  ).rows[0].id

const share = (user: string, fileId: string, days = 7, token = randomUUID()) =>
  asUser(pg, user, (tx) =>
    tx.query(
      `insert into kriya.share_links (id, user_id, token_hash, kind, ref, title, snapshot_file_id, expires_at)
       values ($1, $2, $3, 'receipt', 'ep1', 'Receipt #1', $4, now() + make_interval(days => $5))`,
      [randomUUID().slice(0, 12), user, hash(token), fileId, days]
    )
  )

beforeAll(async () => {
  pg = await createTestDb()
  alice = await createUser(pg)
  bob = await createUser(pg)
})

describe("files", () => {
  it("a person's upload starts pending and can't be born checked", async () => {
    const id = await upload(alice)
    const { rows } = await pg.query(
      "select status, origin from kriya.files where id = $1",
      [id]
    )
    expect(rows[0]).toEqual({ status: "pending", origin: "upload" })
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.files (user_id, name, mime, size_bytes, origin, status, sha256) values ($1, 'x.txt', 'text/plain', 1, 'upload', 'ready', $2)",
          [alice, hash("x")]
        )
      )
    ).rejects.toThrow(/row-level security/)
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.files (user_id, name, mime, size_bytes, origin) values ($1, 'x.pdf', 'application/pdf', 1, 'generated')",
          [alice]
        )
      )
    ).rejects.toThrow(/row-level security/)
  })

  it("refuses types outside the allow-list", async () => {
    await expect(
      asUser(pg, alice, (tx) =>
        tx.query(
          "insert into kriya.files (user_id, name, mime, size_bytes, origin) values ($1, 'a.exe', 'application/x-msdownload', 1, 'upload')",
          [alice]
        )
      )
    ).rejects.toThrow(/files_mime_check/)
  })

  it("only renames; status, text and hash are the server's", async () => {
    const id = await upload(alice)
    await asUser(pg, alice, (tx) =>
      tx.query("update kriya.files set name = 'renamed.txt' where id = $1", [id])
    )
    for (const column of ["status = 'ready'", "text = 'x'", `sha256 = '${hash("y")}'`]) {
      await expect(
        asUser(pg, alice, (tx) =>
          tx.query(`update kriya.files set ${column} where id = $1`, [id])
        )
      ).rejects.toThrow(/permission denied/)
    }
  })

  it("another person finds, changes and deletes nothing", async () => {
    const id = await upload(alice)
    const seen = await asUser(pg, bob, (tx) =>
      tx.query("select id from kriya.files where id = $1", [id])
    )
    expect(seen.rows).toEqual([])
    await asUser(pg, bob, (tx) =>
      tx.query("update kriya.files set name = 'mine' where id = $1", [id])
    )
    await asUser(pg, bob, (tx) => tx.query("delete from kriya.files where id = $1", [id]))
    const { rows } = await pg.query("select name from kriya.files where id = $1", [id])
    expect(rows).toEqual([{ name: "notes.txt" }])
  })

  it("moves only along pending → ready → extracted | failed, pending → rejected", async () => {
    const id = await upload(alice)
    await expect(
      pg.query("update kriya.files set status = 'extracted', sha256 = $2 where id = $1", [
        id,
        hash("a"),
      ])
    ).rejects.toThrow(/can't go from pending to extracted/)
    // Checked files carry their hash
    await expect(
      pg.query("update kriya.files set status = 'ready' where id = $1", [id])
    ).rejects.toThrow(/files_check/)
    await pg.query("update kriya.files set status = 'ready', sha256 = $2 where id = $1", [
      id,
      hash("a"),
    ])
    await pg.query("update kriya.files set status = 'extracted' where id = $1", [id])
    await expect(
      pg.query("update kriya.files set status = 'pending' where id = $1", [id])
    ).rejects.toThrow(/can't go from extracted to pending/)
  })

  it("enforces the plan's file size and storage in SQL", async () => {
    const carol = await createUser(pg)
    await expect(upload(carol, 10 * MB + 1)).rejects.toThrow(/larger than the plan/)
    for (let i = 0; i < 10; i++) await upload(carol, 10 * MB, `f${i}.txt`)
    await expect(upload(carol, 1)).rejects.toThrow(/storage used up/)
    // A rejected file no longer counts
    await pg.query(
      "update kriya.files set status = 'rejected' where user_id = $1 and name = 'f0.txt'",
      [carol]
    )
    await upload(carol, 1)
  })
})

describe("share links", () => {
  it("the token hash can't be read by any session, even the person's", async () => {
    const file = await generated(alice)
    await share(alice, file)
    await expect(
      asUser(pg, alice, (tx) => tx.query("select token_hash from kriya.share_links"))
    ).rejects.toThrow(/permission denied/)
    const own = await asUser(pg, alice, (tx) =>
      tx.query("select id, title from kriya.share_links")
    )
    expect(own.rows.length).toBeGreaterThan(0)
    const other = await asUser(pg, bob, (tx) =>
      tx.query("select id from kriya.share_links")
    )
    expect(other.rows).toEqual([])
  })

  it("expires within 30 days", async () => {
    const file = await generated(alice)
    await expect(share(alice, file, 31)).rejects.toThrow(/share_links_check/)
    await expect(share(alice, file, 0)).rejects.toThrow(/share_links_check/)
    await share(alice, file, 30)
  })

  it("revoking is final and the only change the person can make", async () => {
    const file = await generated(bob)
    await share(bob, file)
    await asUser(pg, bob, (tx) =>
      tx.query("update kriya.share_links set revoked_at = now()")
    )
    await expect(
      asUser(pg, bob, (tx) => tx.query("update kriya.share_links set revoked_at = null"))
    ).rejects.toThrow(/stays revoked/)
    await expect(
      asUser(pg, bob, (tx) =>
        tx.query("update kriya.share_links set expires_at = now() + interval '1 day'")
      )
    ).rejects.toThrow(/permission denied/)
    await expect(
      asUser(pg, bob, (tx) => tx.query("update kriya.share_links set views = 99"))
    ).rejects.toThrow(/permission denied/)
  })

  it("can't be created for someone else", async () => {
    const file = await generated(alice)
    await expect(
      asUser(pg, bob, (tx) =>
        tx.query(
          `insert into kriya.share_links (id, user_id, token_hash, kind, ref, title, snapshot_file_id, expires_at)
           values ('x1', $1, $2, 'receipt', 'r', 't', $3, now() + interval '1 day')`,
          [alice, hash("t"), file]
        )
      )
    ).rejects.toThrow(/row-level security/)
  })

  it("allows at most the plan's live shares", async () => {
    const dave = await createUser(pg)
    const file = await generated(dave)
    for (let i = 0; i < 5; i++) await share(dave, file)
    await expect(share(dave, file)).rejects.toThrow(/share limit/)
    await asUser(pg, dave, (tx) =>
      tx.query(
        "update kriya.share_links set revoked_at = now() where id = (select id from kriya.share_links limit 1)"
      )
    )
    await share(dave, file)
  })

  it("views are visible to the share's person only and written by the server", async () => {
    const erin = await createUser(pg)
    const file = await generated(erin)
    await share(erin, file)
    const { rows } = await pg.query<{ id: string }>(
      "select id from kriya.share_links where user_id = $1",
      [erin]
    )
    await pg.query(
      "insert into kriya.share_views (share_id, user_id, ip_hash) values ($1, $2, 'abc')",
      [rows[0].id, erin]
    )
    const own = await asUser(pg, erin, (tx) =>
      tx.query("select * from kriya.share_views")
    )
    expect(own.rows).toHaveLength(1)
    const other = await asUser(pg, bob, (tx) =>
      tx.query("select * from kriya.share_views")
    )
    expect(other.rows).toEqual([])
    await expect(
      asUser(pg, erin, (tx) =>
        tx.query("insert into kriya.share_views (share_id, user_id) values ($1, $2)", [
          rows[0].id,
          erin,
        ])
      )
    ).rejects.toThrow(/permission denied/)
  })

  it("deleting the snapshot file deletes its share", async () => {
    const frank = await createUser(pg)
    const file = await generated(frank)
    await share(frank, file)
    await pg.query("delete from kriya.files where id = $1", [file])
    const { rows } = await pg.query(
      "select 1 from kriya.share_links where user_id = $1",
      [frank]
    )
    expect(rows).toEqual([])
  })
})
