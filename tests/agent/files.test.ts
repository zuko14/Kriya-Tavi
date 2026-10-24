import { drizzle } from "drizzle-orm/pglite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setDatabaseForTests, type DB } from "@/db"
import * as schema from "@/db/schema"
import { browserDecision, classifyBrowserAction } from "@/lib/agent/policy"
import type { PageElement, PageView } from "@/lib/browser/provider"
import { claimFile, docxText, extractFile, type Reader } from "@/lib/extract"
import {
  confirmUpload,
  createUpload,
  deleteFile,
  downloadUrl,
  fileForBrowserUpload,
  objectPath,
  safeName,
  saveGenerated,
  setFileStoreForTests,
  sniff,
  type FileStore,
} from "@/lib/files"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Files (A5): uploads only for allowed types and sizes, confirmed only when
// the object is there with the right size and bytes (AT-FILE-01); sniffing
// that rejects renamed programs and polyglots (AT-FILE-02); one read per
// content hash (AT-FILE-03); browser uploads only from the person's own
// checked file (AT-BRW-10, the kriya.files half). Storage is in memory.

let pg: TestDb
let alice: string
let bob: string
let objects: Map<string, Buffer>
let removed: string[]

const memoryStore = (): FileStore => ({
  uploadUrl: async (path) => `https://storage.test/upload/${path}?token=t`,
  read: async (path) => objects.get(path) ?? null,
  write: async (path, bytes) => void objects.set(path, bytes),
  signedUrl: async (path, seconds) => `https://storage.test/${path}?expires=${seconds}`,
  remove: async (paths) => {
    for (const path of paths) objects.delete(path)
    removed.push(...paths)
  },
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IHDR fake image data"),
])
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n")

// A stored (uncompressed) zip, enough for a .docx
function zip(entries: Record<string, string>) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content)
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    locals.push(local, n, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(n.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, n)
    offset += 30 + n.length + data.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const DOCX = zip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml":
    "<w:document><w:body><w:p><w:r><w:t>Invoice &amp; receipt</w:t></w:r></w:p><w:p><w:r><w:t>₹1,180</w:t></w:r></w:p></w:body></w:document>",
})

// Uploads `bytes` the way the browser would, after createUpload
async function upload(
  user: string,
  name: string,
  mime: string,
  bytes: Buffer,
  size = bytes.length
) {
  const created = await createUpload(user, { name, mime, size })
  if (!("fileId" in created)) throw new Error(created.error)
  objects.set(objectPath({ userId: user, id: created.fileId! }), bytes)
  return created.fileId!
}

const fileRow = async (id: string) =>
  (
    await pg.query<Record<string, unknown>>("select * from kriya.files where id = $1", [
      id,
    ])
  ).rows[0]

beforeEach(async () => {
  pg = await createTestDb()
  setDatabaseForTests(
    drizzle({ client: pg, schema, casing: "snake_case" }) as unknown as DB
  )
  alice = await createUser(pg)
  bob = await createUser(pg)
  objects = new Map()
  removed = []
  setFileStoreForTests(memoryStore())
})

afterEach(() => setFileStoreForTests(undefined))

describe("AT-FILE-01 upload links and confirmation", () => {
  it("gives a link only for allowed types and sizes within the plan", async () => {
    const ok = await createUpload(alice, {
      name: "notes.txt",
      mime: "text/plain",
      size: 12,
    })
    expect(ok).toMatchObject({ uploadUrl: expect.stringContaining(`${alice}/`) })
    expect(
      await createUpload(alice, {
        name: "a.exe",
        mime: "application/x-msdownload",
        size: 1,
      })
    ).toEqual({ error: "That type of file isn't accepted." })
    expect(
      await createUpload(alice, {
        name: "big.pdf",
        mime: "application/pdf",
        size: 10 * 1048576 + 1,
      })
    ).toEqual({ error: "That file is larger than your plan allows." })
  })

  it("isn't available without storage", async () => {
    setFileStoreForTests(null)
    expect(
      await createUpload(alice, { name: "n.txt", mime: "text/plain", size: 1 })
    ).toEqual({ error: "File storage isn't set up yet." })
  })

  it("confirms only an object that exists with the announced size", async () => {
    const created = await createUpload(alice, {
      name: "n.txt",
      mime: "text/plain",
      size: 5,
    })
    const id = (created as { fileId: string }).fileId
    expect(await confirmUpload(alice, id)).toEqual({
      error: "The upload hasn't arrived yet. Try again in a moment.",
    })
    expect((await fileRow(id)).status).toBe("pending")

    const wrong = await upload(alice, "n.txt", "text/plain", Buffer.from("hello!"), 5)
    expect(await confirmUpload(alice, wrong)).toMatchObject({ status: "rejected" })
    expect(objects.has(objectPath({ userId: alice, id: wrong }))).toBe(false)

    const good = await upload(alice, "n.txt", "text/plain", Buffer.from("hello"))
    expect(await confirmUpload(alice, good)).toEqual({ status: "ready" })
    expect(await fileRow(good)).toMatchObject({
      status: "ready",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    // Idempotent
    expect(await confirmUpload(alice, good)).toEqual({ status: "ready" })
  })

  it("refuses an object larger than announced without downloading it", async () => {
    const inner = memoryStore()
    const read = vi.fn(inner.read)
    setFileStoreForTests({
      ...inner,
      read,
      size: async (path) => objects.get(path)?.length ?? null,
    })
    const big = await upload(alice, "n.txt", "text/plain", Buffer.alloc(50, "a"), 5)
    expect(await confirmUpload(alice, big)).toMatchObject({
      status: "rejected",
      reason: "The upload's size doesn't match.",
    })
    expect(read).not.toHaveBeenCalled()
    expect(objects.has(objectPath({ userId: alice, id: big }))).toBe(false)
    // A matching size still goes on to be read and checked
    const good = await upload(alice, "n.txt", "text/plain", Buffer.from("hello"))
    expect(await confirmUpload(alice, good)).toEqual({ status: "ready" })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("another person can't confirm, download or delete it", async () => {
    const id = await upload(alice, "n.txt", "text/plain", Buffer.from("hello"))
    expect(await confirmUpload(bob, id)).toEqual({ error: "That file wasn't found." })
    await confirmUpload(alice, id)
    expect(await downloadUrl(bob, id)).toBeNull()
    expect(await deleteFile(bob, id)).toBe(false)
    expect(await downloadUrl(alice, id)).toContain("expires=60")
  })

  it("deleting removes the object, then the row", async () => {
    const id = await upload(alice, "n.txt", "text/plain", Buffer.from("hello"))
    expect(await deleteFile(alice, id)).toBe(true)
    expect(removed).toEqual([objectPath({ userId: alice, id })])
    expect(await fileRow(id)).toBeUndefined()
  })

  it("cleans names", () => {
    expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd")
    expect(safeName("bill\u0000\n.pdf")).toBe("bill.pdf")
    expect(safeName("...")).toBe("file")
    expect(safeName("a".repeat(300))).toHaveLength(255)
  })
})

describe("AT-FILE-02 sniffing", () => {
  it("accepts each allowed type when the bytes match", () => {
    expect(sniff(PNG, "image/png")).toEqual({ ok: true, mime: "image/png" })
    expect(sniff(PDF, "application/pdf")).toEqual({ ok: true, mime: "application/pdf" })
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg").ok).toBe(true)
    expect(
      sniff(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "), "image/webp").ok
    ).toBe(true)
    expect(sniff(Buffer.from("date,amount\n2026-10-01,1180\n"), "text/csv").ok).toBe(true)
    expect(sniff(Buffer.from("नमस्ते, తెలుగు, hello"), "text/plain").ok).toBe(true)
    expect(sniff(DOCX, DOCX_MIME).ok).toBe(true)
  })

  it("rejects a renamed program", () => {
    const exe = Buffer.concat([Buffer.from("MZ\u0090\u0000"), Buffer.alloc(60)])
    expect(sniff(exe, "application/pdf")).toEqual({
      ok: false,
      reason: "Programs and scripts can't be uploaded.",
    })
    expect(sniff(Buffer.from("#!/bin/sh\nrm -rf /\n"), "text/plain").ok).toBe(false)
    expect(sniff(Buffer.from("\u007fELF\u0002\u0001"), "image/png").ok).toBe(false)
  })

  it("rejects contents that don't match the declared type", () => {
    expect(sniff(PDF, "image/png").ok).toBe(false)
    expect(sniff(PNG, "text/plain").ok).toBe(false)
    expect(sniff(zip({ "a.txt": "x" }), DOCX_MIME).ok).toBe(false)
  })

  it("rejects polyglots and active PDFs", () => {
    const pngPdf = Buffer.concat([PNG, Buffer.from("%PDF-1.4 hidden document")])
    expect(sniff(pngPdf, "image/png")).toEqual({
      ok: false,
      reason: "The file hides other content inside it.",
    })
    const jpegHtml = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("<script>alert(1)</script>"),
    ])
    expect(sniff(jpegHtml, "image/jpeg").ok).toBe(false)
    const pdfZip = Buffer.concat([PDF, Buffer.from("PK\u0003\u0004appended zip")])
    expect(sniff(pdfZip, "application/pdf").ok).toBe(false)
    const pdfJs = Buffer.from(
      "%PDF-1.7\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"
    )
    expect(sniff(pdfJs, "application/pdf")).toEqual({
      ok: false,
      reason: "PDFs with scripts or attachments aren't accepted.",
    })
  })

  it("rejects an upload whose bytes are a program, at confirmation", async () => {
    const id = await upload(
      alice,
      "cv.pdf",
      "application/pdf",
      Buffer.from("MZ\u0090\u0000rest")
    )
    expect(await confirmUpload(alice, id)).toEqual({
      status: "rejected",
      reason: "Programs and scripts can't be uploaded.",
    })
    expect(objects.size).toBe(0)
  })
})

describe("AT-FILE-03 extraction and its content-hash cache", () => {
  let calls: number
  const reader: Reader = async () => {
    calls++
    return {
      text: "Electricity bill ₹1,180.00 due 2026-10-25",
      model: "scripted/vision",
      inputTokens: 900,
      outputTokens: 20,
      costMicroUsd: 150,
    }
  }
  beforeEach(() => {
    calls = 0
  })

  const readyFile = async (user: string, name: string, mime: string, bytes: Buffer) => {
    const id = await upload(user, name, mime, bytes)
    await confirmUpload(user, id)
    return id
  }

  it("reads text, CSV and Word files without a model", async () => {
    const csv = await readyFile(alice, "a.csv", "text/csv", Buffer.from("a,b\n1,2\n"))
    const docx = await readyFile(alice, "a.docx", DOCX_MIME, DOCX)
    for (let i = 0; i < 2; i++) {
      const row = await claimFile("w1", false)
      expect(await extractFile(row!, { read: null })).toBe("read")
    }
    expect(calls).toBe(0)
    expect((await fileRow(csv)).text).toBe("a,b\n1,2\n")
    expect((await fileRow(docx)).text).toBe("Invoice & receipt\n₹1,180")
    expect(docxText(DOCX)).toBe("Invoice & receipt\n₹1,180")
  })

  it("leaves PDFs and images ready while no reading model is set", async () => {
    await readyFile(alice, "bill.pdf", "application/pdf", PDF)
    expect(await claimFile("w1", false)).toBeNull()
  })

  it("the same bytes are read once per person: no second model call", async () => {
    const first = await readyFile(alice, "bill.pdf", "application/pdf", PDF)
    const again = await readyFile(alice, "bill copy.pdf", "application/pdf", PDF)
    for (let i = 0; i < 2; i++) {
      const row = await claimFile("w1", true)
      await extractFile(row!, { read: reader })
    }
    expect(calls).toBe(1)
    expect((await fileRow(again)).text).toBe((await fileRow(first)).text)
    expect((await fileRow(again)).extraction).toMatchObject({ reusedFrom: first })
    const { rows } = await pg.query(
      "select kind, cost_micro_usd::int as cost from kriya.resource_usage where user_id = $1",
      [alice]
    )
    expect(rows).toEqual([{ kind: "maintenance_model", cost: 150 }])
  })

  it("another person's identical file isn't reused across accounts", async () => {
    await readyFile(alice, "bill.pdf", "application/pdf", PDF)
    await readyFile(bob, "bill.pdf", "application/pdf", PDF)
    for (let i = 0; i < 2; i++) {
      const row = await claimFile("w1", true)
      await extractFile(row!, { read: reader })
    }
    expect(calls).toBe(2)
  })

  it("a leased file isn't claimed twice; over the cap it waits", async () => {
    await readyFile(alice, "bill.pdf", "application/pdf", PDF)
    const row = await claimFile("w1", true)
    expect(await claimFile("w2", true)).toBeNull()
    expect(await extractFile(row!, { read: reader, allowed: async () => false })).toBe(
      "skipped"
    )
    expect(calls).toBe(0)
    expect((await fileRow(row!.id)).status).toBe("ready")
  })

  it("a reader error marks the file failed", async () => {
    const id = await readyFile(alice, "bill.pdf", "application/pdf", PDF)
    const row = await claimFile("w1", true)
    const broken: Reader = async () => {
      throw new Error("provider down")
    }
    expect(await extractFile(row!, { read: broken })).toBe("failed")
    expect(await fileRow(id)).toMatchObject({ status: "failed" })
  })

  it("generated files aren't extracted", async () => {
    await saveGenerated(alice, {
      name: "receipt.pdf",
      mime: "application/pdf",
      bytes: PDF,
      origin: "generated",
    })
    expect(await claimFile("w1", true)).toBeNull()
  })
})

describe("AT-BRW-10 browser uploads come only from kriya.files", () => {
  it("returns the person's own checked file, and nothing else", async () => {
    const id = await upload(alice, "resume.pdf", "application/pdf", PDF)
    // Not checked yet
    expect(await fileForBrowserUpload(alice, id)).toBeNull()
    await confirmUpload(alice, id)
    expect(await fileForBrowserUpload(alice, id)).toEqual({
      name: "resume.pdf",
      mime: "application/pdf",
      data: PDF.toString("base64"),
    })
    expect(await fileForBrowserUpload(bob, id)).toBeNull()
    // Bytes changed in storage since the check: refused
    objects.set(objectPath({ userId: alice, id }), Buffer.from("%PDF-1.4 swapped"))
    expect(await fileForBrowserUpload(alice, id)).toBeNull()
  })

  it("an upload is always R4, R5 into a sensitive field, refused off supervised sites", () => {
    const page = (element: Partial<PageElement>): PageView => ({
      elements: [
        {
          ref: "e1",
          role: "textbox",
          name: "Resume",
          inForm: true,
          sensitive: false,
          type: "file",
          ...element,
        },
      ],
      facts: {
        url: "https://jobs.test/apply",
        domain: "jobs.test",
        hasForm: true,
        focusedSensitive: false,
        captcha: false,
      },
    })
    const upload = { action: "upload" as const, ref: "e1", fileId: "f1" }
    expect(classifyBrowserAction(upload, page({}), null)).toBe("R4")
    // Not a commit word, not a submit button: still R4
    expect(
      classifyBrowserAction(upload, page({ name: "Photo", role: "button" }), null)
    ).toBe("R4")
    expect(classifyBrowserAction(upload, page({ sensitive: true }), null)).toBe("R5")
    expect(browserDecision(upload, page({}), null)).toMatchObject({
      cls: "R4",
      gate: "refuse",
    })
    expect(
      browserDecision(upload, page({}), {
        domain: "jobs.test",
        mode: "supervised",
        reviewed: null,
      })
    ).toMatchObject({ cls: "R4", gate: "user-approval" })
  })

  it("a rejected file can't be uploaded", async () => {
    const id = await upload(alice, "x.pdf", "application/pdf", Buffer.from("MZ\u0090"))
    await confirmUpload(alice, id)
    expect(await fileForBrowserUpload(alice, id)).toBeNull()
  })
})
