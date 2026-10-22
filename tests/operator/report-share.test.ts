import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import type { BrowserProvider } from "@/lib/browser/provider"
import { setBrowserProviderForTests } from "@/lib/browser/session"
import { setFileStoreForTests, type FileStore } from "@/lib/files"
import { createShare, jobReportPdf, openShare } from "@/lib/share"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Sharing a job's handover report (O5, K8; owner-approved 2026-10-22): only
// a completed job of the person's own, as a snapshot PDF made from the
// verdict now. Renderer and storage are in memory.

let pg: TestDb
let alice: string
let bob: string
let rendered: string[]

const store = (): FileStore => ({
  uploadUrl: async (p) => `https://storage.test/upload/${p}`,
  read: async () => null,
  write: async () => {},
  signedUrl: async (p) => `https://storage.test/${p}`,
  remove: async () => {},
})
const renderer = {
  renderPdf: async (html: string) => {
    rendered.push(html)
    return Buffer.from("%PDF-1.4\n%%EOF\n")
  },
} as unknown as BrowserProvider

async function job(user: string, id: string, status: string) {
  await pg.query(
    `insert into kriya.mandates (id, user_id, title, objective, criteria, due_at, proposed_by, confirmed)
     values ($1, $2, 'Get invoice 12 paid', 'Chase it',
       '[{"id":"c1","text":"Client agreed","evidence":{"kind":"person_confirmed"}}]',
       now() + interval '7 days', 'person', '{c1}')`,
    [id, user]
  )
  if (status !== "proposed") {
    await pg.query("update kriya.mandates set status = 'active' where id = $1", [id])
    if (status !== "active")
      await pg.query("update kriya.mandates set status = $2 where id = $1", [id, status])
  }
}

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  rendered = []
  setFileStoreForTests(store())
  setBrowserProviderForTests(renderer)
})
afterEach(() => {
  setFileStoreForTests(undefined)
  setBrowserProviderForTests(null)
})

describe("sharing a job report", () => {
  it("a completed job's report becomes a report share with its own snapshot", async () => {
    await job(alice, "m1", "completed")
    const result = await createShare(alice, { kind: "report", ref: "m1", days: 7 })
    if (!result.path) throw new Error(result.error)
    expect(rendered[0]).toContain("Confirmed by you")
    const opened = await openShare(result.path.split("/").pop()!)
    expect(opened).toMatchObject({ kind: "report", title: "Get invoice 12 paid" })
    const { rows } = await pg.query("select kind, ref from kriya.share_links")
    expect(rows).toEqual([{ kind: "report", ref: "m1" }])
  })

  it("refuses a job that isn't completed, and another person's", async () => {
    await job(alice, "m2", "active")
    await job(bob, "m3", "completed")
    expect(
      await createShare(alice, { kind: "report", ref: "m2", days: 7 })
    ).toHaveProperty("error")
    expect(
      await createShare(alice, { kind: "report", ref: "m3", days: 7 })
    ).toHaveProperty("error")
    expect(rendered).toEqual([])
    const { rows } = await pg.query("select count(*)::int as n from kriya.share_links")
    expect(rows[0]).toEqual({ n: 0 })
  })

  it("the download PDF works for any started job, the share only for completed", async () => {
    await job(alice, "m4", "active")
    expect(await jobReportPdf(alice, "m4")).toMatchObject({
      title: "Get invoice 12 paid",
    })
    expect(await jobReportPdf(alice, "m4", { completedOnly: true })).toBeNull()
    await job(alice, "m5", "proposed")
    expect(await jobReportPdf(alice, "m5")).toBeNull()
  })
})
